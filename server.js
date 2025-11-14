import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import Airtable from 'airtable';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events
} from 'discord.js';

/* ---------------- CONFIG ---------------- */

const {
  DISCORD_TOKEN,
  DISCORD_DEALS_CHANNEL_ID,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_INVENTORY_TABLE,
  AIRTABLE_PARTNER_OFFERS_TABLE,
  PORT = 10000
} = process.env;

/* ---------------- Airtable ---------------- */

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const inventoryTableName = AIRTABLE_INVENTORY_TABLE || 'Inventory Units';
const partnerOffersTableName = AIRTABLE_PARTNER_OFFERS_TABLE || 'Partner Offers';

/* ---------------- Discord ---------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, c => {
  console.log(`🤖 Partner Deal Bot logged in as ${c.user.tag}`);
});

client.login(DISCORD_TOKEN);

/* Helper */
function getValueFromLines(lines, label) {
  const line = lines.find(l => l.startsWith(label));
  if (!line) return '';
  return line.split(label)[1].trim();
}

/* ---------------- Express ---------------- */

const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => res.type('text/plain').send('Partner Deal Bot OK'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/**
 * POST /partner-deal
 * Make sends payload here
 */
app.post('/partner-deal', async (req, res) => {
  try {
    const {
      productName,
      sku,
      size,
      brand,
      startPayout,
      payoutMethod,
      imageUrl,
      dealId
    } = req.body || {};

    if (!productName || !sku || !size || !brand || !startPayout) {
      return res.status(400).json({ error: 'Missing required fields in payload.' });
    }

    const channel = await client.channels.fetch(DISCORD_DEALS_CHANNEL_ID);

    const descriptionLines = [
      `**Product:** ${productName}`,
      `**SKU:** ${sku}`,
      `**Size:** ${size}`,
      `**Brand:** ${brand}`,
      `**Start Payout:** €${Number(startPayout).toFixed(2)}`,
      payoutMethod ? `**Payout Method:** ${payoutMethod}` : null,
      dealId ? `**Deal ID:** ${dealId}` : null
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle('🧨 NEW DEAL 🧨')
      .setDescription(descriptionLines.join('\n'))
      .setColor(0xf1c40f);

    if (imageUrl) embed.setImage(imageUrl);

    const buttonsRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('partner_claim')
        .setLabel('Claim Deal')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('partner_offer')
        .setLabel('Offer')
        .setStyle(ButtonStyle.Secondary)
    );

    const msg = await channel.send({
      embeds: [embed],
      components: [buttonsRow]
    });

    return res.json({ ok: true, messageId: msg.id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

/* ------------ Interaction logic ------------ */

client.on(Events.InteractionCreate, async interaction => {
  try {
    /* BUTTONS */
    if (interaction.isButton()) {
      const messageId = interaction.message.id;
      const embed = interaction.message.embeds?.[0];

      if (!embed) {
        return interaction.reply({ content: '❌ No deal embed found.', ephemeral: true });
      }

      /* CLAIM BUTTON */
      if (interaction.customId === 'partner_claim') {
        const modal = new ModalBuilder()
          .setCustomId(`partner_claim_modal:${messageId}`)
          .setTitle('Claim Deal');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('seller_id')
              .setLabel('Your Seller ID')
              .setRequired(true)
              .setStyle(TextInputStyle.Short)
          )
        );

        return interaction.showModal(modal);
      }

      /* OFFER BUTTON */
      if (interaction.customId === 'partner_offer') {
        const modal = new ModalBuilder()
          .setCustomId(`partner_offer_modal:${messageId}`)
          .setTitle('Make an Offer');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('seller_id')
              .setLabel('Your Seller ID')
              .setRequired(true)
              .setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('offer_price')
              .setLabel('Your Offer (€)')
              .setRequired(true)
              .setStyle(TextInputStyle.Short)
          )
        );

        return interaction.showModal(modal);
      }
    }

    /* MODAL SUBMISSIONS */
    if (interaction.isModalSubmit()) {
      const [prefix, messageId] = interaction.customId.split(':');

      const msg = await interaction.channel.messages.fetch(messageId).catch(() => null);
      const embed = msg?.embeds?.[0];

      if (!embed || !embed.description)
        return interaction.reply({ content: '❌ Missing deal details.', ephemeral: true });

      const lines = embed.description.split('\n');

      const productName = getValueFromLines(lines, '**Product:**');
      const sku = getValueFromLines(lines, '**SKU:**');
      const size = getValueFromLines(lines, '**Size:**');
      const brand = getValueFromLines(lines, '**Brand:**');
      const startPayout = parseFloat(getValueFromLines(lines, '**Start Payout:**')
        ?.replace('€', '')
        ?.replace(',', '.') || '0');

      const dealId = getValueFromLines(lines, '**Deal ID:**') || messageId;

      const sellerId = interaction.fields.getTextInputValue('seller_id').trim();

      /* ---- CLAIM ---- */
      if (prefix === 'partner_claim_modal') {
        await base(inventoryTableName).create({
          'Product Name': productName,
          'SKU': sku,
          'Size': size,
          'Brand': brand,
          'Purchase Price': startPayout,
          'Seller ID Text': sellerId,
          'Ticket Number': dealId,
          'Purchase Date': new Date().toISOString().split('T')[0],
          'Source': 'Partner Deal'
        });

        return interaction.reply({
          content: `✅ Deal claimed.\nSeller: \`${sellerId}\``,
          ephemeral: true
        });
      }

      /* ---- OFFER ---- */
      if (prefix === 'partner_offer_modal') {
        const offerPrice = parseFloat(
          interaction.fields.getTextInputValue('offer_price')
            .replace(',', '.') || '0'
        );

        await base(partnerOffersTableName).create({
          'Product Name': productName,
          'SKU': sku,
          'Size': size,
          'Brand': brand,
          'Start Payout': startPayout,
          'Seller ID Text': sellerId,
          'Seller Offer': offerPrice,
          'Ticket / Deal ID': dealId,
          'Source': 'Partner Deal',
          'Discord Message ID': messageId,
          'Created At': new Date().toISOString()
        });

        return interaction.reply({
          content: `✅ Offer submitted.\n€${offerPrice.toFixed(2)} — Seller \`${sellerId}\``,
          ephemeral: true
        });
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: '❌ Something went wrong.',
          ephemeral: true
        });
      } catch (_) {}
    }
  }
});

/* Start server */
app.listen(PORT, () => {
  console.log(`🌐 Partner Deal Bot HTTP server running on port ${PORT}`);
});

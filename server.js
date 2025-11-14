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

/* ---------------- ENV CONFIG ---------------- */

const {
  DISCORD_TOKEN,
  DISCORD_DEALS_CHANNEL_ID,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_INVENTORY_TABLE,
  AIRTABLE_PARTNER_OFFERS_TABLE,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_DEALS_CHANNEL_ID || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('❌ Missing required environment variables.');
  process.exit(1);
}

/* ---------------- Airtable ---------------- */

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

// Table names can be overridden by envs
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

/* ---------------- Helpers ---------------- */

/**
 * Extracts a value from lines like:
 *  "**SKU:** 1234"
 * called with label = "**SKU:**"
 */
function getValueFromLines(lines, label) {
  const line = lines.find(l => l.startsWith(label));
  if (!line) return '';
  return line.split(label)[1].trim();
}

/* ---------------- Express HTTP API ---------------- */

const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) =>
  res.type('text/plain').send('Partner Deal Bot OK')
);

app.get('/health', (_req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

/**
 * POST /partner-deal
 *
 * Expected payload from Make:
 * {
 *   "productName": "...",
 *   "sku": "...",
 *   "size": "...",
 *   "brand": "...",
 *   "startPayout": "...",
 *   "imageUrl": "...",
 *   "dealId": "...",
 *   "recordId": "recXXXXXXXXXXXXXX"   // Airtable Order record ID
 * }
 */
app.post('/partner-deal', async (req, res) => {
  try {
    const {
      productName,
      sku,
      size,
      brand,
      startPayout,
      imageUrl,
      dealId,
      recordId // Airtable Order record ID
    } = req.body || {};

    if (!productName || !sku || !size || !brand || !startPayout) {
      return res.status(400).json({ error: 'Missing required fields in payload.' });
    }

    const channel = await client.channels.fetch(DISCORD_DEALS_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ error: 'Deals channel not found or not text-based.' });
    }

    const descriptionLines = [
      `**Product:** ${productName}`,
      `**SKU:** ${sku}`,
      `**Size:** ${size}`,
      `**Brand:** ${brand}`,
      `**Start Payout:** €${Number(startPayout).toFixed(2)}`,
      dealId ? `**Deal ID:** ${dealId}` : null,
      recordId ? `**Order Record ID:** ${recordId}` : null // Store Order record ID for later linking
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle('🧨 NEW DEAL 🧨')
      .setDescription(descriptionLines.join('\n'))
      .setColor(0xf1c40f);

    if (imageUrl) {
      embed.setImage(imageUrl);
    }

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
    console.error('Error in /partner-deal:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
});

/* ---------------- Discord Interaction Logic ---------------- */

client.on(Events.InteractionCreate, async interaction => {
  try {
    /* ---------- BUTTONS ---------- */
    if (interaction.isButton()) {
      const messageId = interaction.message.id;
      const embed = interaction.message.embeds?.[0];

      if (!embed) {
        return interaction.reply({ content: '❌ No deal embed found.', ephemeral: true });
      }

      // CLAIM DEAL button
      if (interaction.customId === 'partner_claim') {
        const modal = new ModalBuilder()
          .setCustomId(`partner_claim_modal:${messageId}`)
          .setTitle('Claim Deal');

        const sellerIdInput = new TextInputBuilder()
          .setCustomId('seller_id')
          .setLabel('Your Seller ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(sellerIdInput);
        modal.addComponents(row);

        return interaction.showModal(modal);
      }

      // OFFER button
      if (interaction.customId === 'partner_offer') {
        const modal = new ModalBuilder()
          .setCustomId(`partner_offer_modal:${messageId}`)
          .setTitle('Make an Offer');

        const sellerIdInput = new TextInputBuilder()
          .setCustomId('seller_id')
          .setLabel('Your Seller ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const offerInput = new TextInputBuilder()
          .setCustomId('offer_price')
          .setLabel('Your Offer (€)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g. 140');

        const row1 = new ActionRowBuilder().addComponents(sellerIdInput);
        const row2 = new ActionRowBuilder().addComponents(offerInput);

        modal.addComponents(row1, row2);

        return interaction.showModal(modal);
      }
    }

    /* ---------- MODALS ---------- */
    if (interaction.isModalSubmit()) {
      const [prefix, messageId] = interaction.customId.split(':');

      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) {
        return interaction.reply({
          content: '❌ Could not find the original deal message.',
          ephemeral: true
        });
      }

      const msg = await channel.messages.fetch(messageId).catch(() => null);
      const embed = msg?.embeds?.[0];

      if (!embed || !embed.description) {
        return interaction.reply({ content: '❌ Missing deal details.', ephemeral: true });
      }

      const lines = embed.description.split('\n');

      const productName = getValueFromLines(lines, '**Product:**');
      const sku = getValueFromLines(lines, '**SKU:**');
      const size = getValueFromLines(lines, '**Size:**');
      const brand = getValueFromLines(lines, '**Brand:**');
      const startPayout = parseFloat(
        getValueFromLines(lines, '**Start Payout:**')
          ?.replace('€', '')
          ?.replace(',', '.') || '0'
      );

      const dealId = getValueFromLines(lines, '**Deal ID:**') || messageId;
      const orderRecordId = getValueFromLines(lines, '**Order Record ID:**') || null;

      const sellerId = interaction.fields.getTextInputValue('seller_id').trim();

      /* ---- CLAIM DEAL MODAL ---- */
      if (prefix === 'partner_claim_modal') {
        const fields = {
          // 🔽 adjust field names below to your actual Airtable fields:
          'Product Name': productName,
          'SKU': sku,
          'Size': size,
          'Brand': brand,
          'Purchase Price': startPayout,
          'Seller ID Text': sellerId,      // e.g. replace with 'Seller ID (Text)' if needed
          'Ticket Number': dealId,
          'Purchase Date': new Date().toISOString().split('T')[0],
          'Source': 'Partner Deal'
        };

        // Linked Order field (Linked record to Orders table)
        // Change 'Linked Order' to your actual linked-record field name.
        if (orderRecordId) {
          fields['Linked Order'] = [orderRecordId];
        }

        await base(inventoryTableName).create(fields);

        return interaction.reply({
          content: `✅ Deal claimed for **${productName} (${size})**.\nSeller: \`${sellerId}\``,
          ephemeral: true
        });
      }

      /* ---- OFFER MODAL ---- */
      if (prefix === 'partner_offer_modal') {
        const rawOffer = interaction.fields.getTextInputValue('offer_price').trim();
        const offerPrice = parseFloat(rawOffer.replace(',', '.') || '0');

        const fields = {
          // 🔽 adjust field names below to your actual Airtable fields:
          'Product Name': productName,
          'SKU': sku,
          'Size': size,
          'Brand': brand,
          'Start Payout': startPayout,
          'Seller ID Text': sellerId,        // e.g. replace with 'Seller ID (Text)' if needed
          'Seller Offer': offerPrice,
          'Ticket / Deal ID': dealId,
          'Source': 'Partner Deal',
          'Discord Message ID': messageId,
          'Created At': new Date().toISOString()
        };

        // Same linked order field here
        if (orderRecordId) {
          fields['Linked Order'] = [orderRecordId]; // change to your real field name if needed
        }

        await base(partnerOffersTableName).create(fields);

        return interaction.reply({
          content:
            `✅ Offer submitted for **${productName} (${size})**.\n` +
            `Seller: \`${sellerId}\`\n` +
            `Offer: €${offerPrice.toFixed(2)}`,
          ephemeral: true
        });
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: '❌ Something went wrong handling this interaction.',
          ephemeral: true
        });
      } catch (_) {
        // ignore
      }
    }
  }
});

/* ---------------- Start HTTP server ---------------- */

app.listen(PORT, () => {
  console.log(`🌐 Partner Deal Bot HTTP server running on port ${PORT}`);
});

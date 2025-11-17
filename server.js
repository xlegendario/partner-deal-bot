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
  AIRTABLE_SELLERS_TABLE,
  AIRTABLE_ORDERS_TABLE,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_DEALS_CHANNEL_ID || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('❌ Missing required environment variables.');
  process.exit(1);
}

/* ---------------- Airtable ---------------- */

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const inventoryTableName = AIRTABLE_INVENTORY_TABLE || 'Inventory Units';
const partnerOffersTableName = AIRTABLE_PARTNER_OFFERS_TABLE || 'Partner Offers';
const sellersTableName = AIRTABLE_SELLERS_TABLE || 'Sellers Database';
const ordersTableName = AIRTABLE_ORDERS_TABLE || 'Unfulfilled Orders Log';

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
 * Extract value from description lines like:
 *  "**SKU:** 1234"
 * with label = "**SKU:**"
 */
function getValueFromLines(lines, label) {
  const line = lines.find(l => l.startsWith(label));
  if (!line) return '';
  return line.split(label)[1].trim();
}

async function findOrderRecordIdByMessageId(messageId) {
  const records = await base(ordersTableName)
    .select({
      maxRecords: 1,
      // field in Unfulfilled Orders Log where we stored the Discord message ID
      filterByFormula: `{Partner Deal Message ID} = "${messageId}"`
    })
    .firstPage();

  return records[0]?.id || null;
}


/**
 * Find Seller record in Sellers Database by Seller Code (e.g. "SE-00385")
 * Assumes primary / first column in Sellers Database is "Seller ID"
 */
async function findSellerRecordIdByCode(sellerCode) {
  if (!sellerCode) return null;

  const sellersTable = base(sellersTableName);

  const records = await sellersTable
    .select({
      maxRecords: 1,
      // 🔽 adjust "Seller ID" if primary field has another name
      filterByFormula: `{Seller ID} = "${sellerCode}"`
    })
    .firstPage();

  if (!records || records.length === 0) return null;
  return records[0].id;
}

/**
 * Build the action row with Claim / Offer buttons.
 * If disabled=true, both buttons are disabled (dark grey).
 */
function buildButtonsRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('partner_claim')
      .setLabel('Claim Deal')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('partner_offer')
      .setLabel('Offer')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
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
 *   "dealId": "...",      // Order ID (human readable)
 *   "recordId": "rec..."  // Airtable record ID of Unfulfilled Orders Log
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
      recordId // order record ID from Unfulfilled Orders Log
    } = req.body || {};

    if (!productName || !sku || !size || !brand || !startPayout) {
      return res.status(400).json({ error: 'Missing required fields in payload.' });
    }

    const channel = await client.channels.fetch(DISCORD_DEALS_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ error: 'Deals channel not found or not text-based.' });
    }

    const descriptionLines = [
      `**Product Name:** ${productName}`,
      `**SKU:** ${sku}`,
      `**Size:** ${size}`,
      `**Brand:** ${brand}`,
      `**Payout:** €${Number(startPayout).toFixed(2)}`,
      dealId ? `**Order ID:** ${dealId}` : null
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle('🧨 NEW DEAL 🧨')
      .setDescription(descriptionLines.join('\n'))
      .setColor(0xf1c40f);

    if (imageUrl) {
      embed.setImage(imageUrl);
    }

    const msg = await channel.send({
      embeds: [embed],
      components: [buildButtonsRow(false)] // enabled buttons
    });

    // Store messageId on the order record, and RESET the "buttons disabled" flag
    if (recordId) {
      try {
        await base(ordersTableName).update(recordId, {
          // field in Unfulfilled Orders Log (single line text)
          'Partner Deal Message ID': msg.id,
          // checkbox field (false = unchecked)
          'Partner Deal Buttons Disabled': false
        });
      } catch (e) {
        console.error('Failed to update order record with message ID / reset flag:', e);
      }
    }

    return res.json({ ok: true, messageId: msg.id });
  } catch (err) {
    console.error('Error in /partner-deal:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
});

/**
 * POST /partner-deal/disable
 *
 * Body:
 * {
 *   "recordId": "recXXXXXXXXXXXX"   // Airtable Unfulfilled Orders Log record ID
 * }
 *
 * Called by Airtable automation when Fulfillment Status changes
 * to Allocated, Claim Processing, Cancelled, Store Fulfilled, etc.
 */
app.post('/partner-deal/disable', async (req, res) => {
  try {
    const { recordId } = req.body || {};
    if (!recordId) {
      return res.status(400).json({ error: 'Missing recordId.' });
    }

    // 1) Load order
    const orderRecord = await base(ordersTableName).find(recordId);
    if (!orderRecord) {
      return res.status(404).json({ error: 'Order record not found.' });
    }

    const messageId = orderRecord.get('Partner Deal Message ID');
    if (!messageId) {
      return res.status(404).json({ error: 'No Partner Deal Message ID stored on order.' });
    }

    // 2) Fetch channel + message
    const channel = await client.channels.fetch(DISCORD_DEALS_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ error: 'Deals channel not found or not text-based.' });
    }

    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) {
      return res.status(404).json({ error: 'Discord message not found.' });
    }

    // 3) Disable buttons (keep them visible)
    await msg.edit({ components: [buildButtonsRow(true)] });

    // 4) Mark as disabled in Airtable (so automation won't re-trigger)
    try {
      await base(ordersTableName).update(recordId, {
        'Partner Deal Buttons Disabled': true
      });
    } catch (e) {
      console.error('Failed to set Partner Deal Buttons Disabled = true:', e);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error in /partner-deal/disable:', err);
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
          .setTitle('Enter Seller ID'); // matches your screenshot

        const sellerIdInput = new TextInputBuilder()
          .setCustomId('seller_id')
          .setLabel('Seller ID (e.g. 00001)')  // what they see
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('00001');            // clean example

        const row = new ActionRowBuilder().addComponents(sellerIdInput);
        modal.addComponents(row);

        return interaction.showModal(modal);
      }

      // OFFER button
      if (interaction.customId === 'partner_offer') {
        const modal = new ModalBuilder()
          .setCustomId(`partner_offer_modal:${messageId}`)
          .setTitle('Enter Seller ID & Offer');

        const sellerIdInput = new TextInputBuilder()
          .setCustomId('seller_id')
          .setLabel('Seller ID (e.g. 00001)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('00001');

        const offerInput = new TextInputBuilder()
          .setCustomId('offer_price')
          .setLabel('Your Offer (€)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('140');

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

      const productName = getValueFromLines(lines, '**Product Name:**');
      const sku = getValueFromLines(lines, '**SKU:**');
      const size = getValueFromLines(lines, '**Size:**');
      const brand = getValueFromLines(lines, '**Brand:**');
      const startPayout = parseFloat(
        getValueFromLines(lines, '**Payout:**')
          ?.replace('€', '')
          ?.replace(',', '.') || '0'
      );

      const dealId = getValueFromLines(lines, '**Order ID:**') || messageId;
      const orderRecordId = await findOrderRecordIdByMessageId(messageId);

      // Seller number (digits only), we will build full code "SE-XXX"
      const sellerNumberRaw = interaction.fields.getTextInputValue('seller_id').trim();

      if (!/^\d+$/.test(sellerNumberRaw)) {
        return interaction.reply({
          content: '❌ Seller Number must contain digits only (no SE-, just the digits). Please try again.',
          ephemeral: true
        });
      }

      const sellerCode = `SE-${sellerNumberRaw}`;
      const sellerRecordId = await findSellerRecordIdByCode(sellerCode);
      if (!sellerRecordId) {
        return interaction.reply({
          content: `❌ Could not find a seller with ID \`${sellerCode}\` in Sellers Database.`,
          ephemeral: true
        });
      }

      /* ---- CLAIM DEAL MODAL ---- */
      if (prefix === 'partner_claim_modal') {
        const fields = {
          // Inventory Units mapping:
          'Product Name': productName,
          'SKU': sku,
          'Size': size,
          'Brand': brand,
          'Purchase Price': startPayout,
          'Shipping Deduction': 0,
          'Ticket Number': dealId,
          'Purchase Date': new Date().toISOString().split('T')[0],
          'Source': 'Outsourced',
          'Verification Status': 'Verified',
          'Payment Note': startPayout.toFixed(2).replace('.', ','),
          'Payment Status': 'To Pay',
          'Availability Status': 'Reserved',
          'Margin %': '10%',
          'Type': 'Custom'
        };

        // Linked Seller ID (linked record)
        fields['Seller ID'] = [sellerRecordId];

        // Link to Unfulfilled Orders Log (linked record)
        if (orderRecordId) {
          // If your Inventory Units linked field has another name, change it here
          fields['Unfulfilled Orders Log'] = [orderRecordId];
        }

        // 1) Create Inventory Unit
        await base(inventoryTableName).create(fields);

        // 2) Disable buttons (keep visible but grey)
        try {
          if (msg) {
            await msg.edit({ components: [buildButtonsRow(true)] });
          }
        } catch (e) {
          console.error('Failed to disable buttons after claim:', e);
        }

        // 3) Mark "Partner Deal Buttons Disabled" on the order as true (if we know the order)
        if (orderRecordId) {
          try {
            await base(ordersTableName).update(orderRecordId, {
              'Partner Deal Buttons Disabled': true
            });
          } catch (e) {
            console.error('Failed to set Partner Deal Buttons Disabled = true after claim:', e);
          }
        }

        // 4) Reply to the user
        return interaction.reply({
          content: `✅ Deal claimed for **${productName} (${size})**.\nSeller: \`${sellerCode}\``,
          ephemeral: true
        });
      }

      /* ---- OFFER MODAL ---- */
      if (prefix === 'partner_offer_modal') {
        const rawOffer = interaction.fields.getTextInputValue('offer_price').trim();
        const offerPrice = parseFloat(rawOffer.replace(',', '.') || '0');

        const fields = {
          // Partner Offers mapping:
          'Partner Offer': offerPrice, // using the offer the partner typed
          'Offer Date': new Date().toISOString().split('T')[0]
        };

        // Linked Seller ID (linked record)
        fields['Seller ID'] = [sellerRecordId];

        // Link to Orders - field is "Linked Orders" in Partner Offers
        if (orderRecordId) {
          fields['Linked Orders'] = [orderRecordId];
        }

        await base(partnerOffersTableName).create(fields);

        return interaction.reply({
          content:
            `✅ Offer submitted for **${productName} (${size})**.\n` +
            `Seller: \`${sellerCode}\`\n` +
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

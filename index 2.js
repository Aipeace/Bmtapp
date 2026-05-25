/**
 * bot/index.js
 * Bybit P2P Merchant Telegram Bot
 *
 * Run: node bot/index.js   (on Railway / Render / VPS — NOT on Vercel)
 * Deps: npm install node-telegram-bot-api node-cron dotenv
 */

'use strict';

require('dotenv').config();
const TelegramBot  = require('node-telegram-bot-api');
const cron         = require('node-cron');
const path         = require('path');
const BybitP2PApi  = require(path.join(__dirname, '../lib/bybit-api'));

// ── Guards ────────────────────────────────────────────────────────────────────
if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
if (!process.env.BYBIT_API_KEY)      throw new Error('BYBIT_API_KEY is not set');
if (!process.env.BYBIT_API_SECRET)   throw new Error('BYBIT_API_SECRET is not set');

// ── Init ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const api = new BybitP2PApi(
  process.env.BYBIT_API_KEY,
  process.env.BYBIT_API_SECRET,
  process.env.BYBIT_TESTNET === 'true'
);

const MINI_APP_URL = (process.env.MINI_APP_URL || 'https://your-app.vercel.app').replace(/\/$/, '');

// ── State (use Redis in production) ───────────────────────────────────────────
const sessions       = new Map();  // chatId → { chatMode, activeOrderId, awaitingAdField, ... }
const priceAlerts    = new Map();  // chatId → [{ token, currency, side, targetPrice, above }]
const orderWatchers  = new Set();  // chatIds subscribed to push notifications
const orderSnapshot  = new Map();  // orderId → last known order object

// ── Utility ───────────────────────────────────────────────────────────────────
const fmt = (n, d = 2) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const sideLabel = (s) => (String(s) === '0' ? '🟢 BUY' : '🔴 SELL');

const ORDER_STATUS = {
  '5':  '🔄 In Progress',
  '10': '⏳ Waiting Payment',
  '20': '💳 Paid – Awaiting Release',
  '30': '✅ Completed',
  '40': '❌ Cancelled',
  '50': '⚠️ Appeal',
};
const statusLabel = (s) => ORDER_STATUS[String(s)] || `Status ${s}`;

function session(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId);
}

async function send(chatId, text, extra = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
  } catch (e) {
    console.error(`[send] chatId=${chatId}:`, e.message);
  }
}

function keyboard(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

// ── Main Menu ─────────────────────────────────────────────────────────────────
function showMenu(chatId) {
  return send(chatId, '🏪 *Bybit P2P Merchant Hub*\n\nWhat would you like to do?',
    keyboard([
      [{ text: '📋 My Ads',     callback_data: 'ads_list'    },
       { text: '📦 Orders',     callback_data: 'orders_list' }],
      [{ text: '💬 Chat',       callback_data: 'chat_menu'   },
       { text: '🔔 Alerts',     callback_data: 'alerts_menu' }],
      [{ text: '📊 Analytics',  callback_data: 'analytics'   },
       { text: '💰 Balance',    callback_data: 'balance'     }],
      [{ text: '🖥️ Open Mini App', web_app: { url: MINI_APP_URL } }],
    ])
  );
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  orderWatchers.add(msg.chat.id);
  send(msg.chat.id,
    `👋 Welcome back, *${msg.from.first_name}*!\n\n` +
    `I'm your Bybit P2P assistant. Use the menu below or type /help.`
  );
  setTimeout(() => showMenu(msg.chat.id), 400);
});

bot.onText(/\/menu/,       (msg) => showMenu(msg.chat.id));
bot.onText(/\/ads/,        (msg) => showAds(msg.chat.id));
bot.onText(/\/orders/,     (msg) => showOrders(msg.chat.id));
bot.onText(/\/balance/,    (msg) => showBalance(msg.chat.id));
bot.onText(/\/analytics/,  (msg) => showAnalytics(msg.chat.id));
bot.onText(/\/alerts/,     (msg) => listAlerts(msg.chat.id));
bot.onText(/\/watch/,      (msg) => {
  orderWatchers.add(msg.chat.id);
  send(msg.chat.id, '👁️ Subscribed to order push notifications.');
});
bot.onText(/\/clearalerts/, (msg) => {
  priceAlerts.delete(msg.chat.id);
  send(msg.chat.id, '✅ All price alerts cleared.');
});

bot.onText(/\/alert (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const parts  = match[1].trim().split(/\s+/);
  if (parts.length < 5) {
    return send(chatId,
      '⚠️ Format: `/alert TOKEN CURRENCY SIDE PRICE DIRECTION`\n' +
      'Example: `/alert USDT NGN SELL 1600 ABOVE`'
    );
  }
  const [token, currency, side, price, dir] = parts;
  if (!priceAlerts.has(chatId)) priceAlerts.set(chatId, []);
  priceAlerts.get(chatId).push({
    token:       token.toUpperCase(),
    currency:    currency.toUpperCase(),
    side:        side.toUpperCase(),
    targetPrice: parseFloat(price),
    above:       dir.toUpperCase() === 'ABOVE',
  });
  send(chatId,
    `🔔 Alert set!\n\n` +
    `*${token}/${currency} ${side}* → notify when price goes ` +
    `*${dir.toUpperCase() === 'ABOVE' ? '⬆️ ABOVE' : '⬇️ BELOW'}* \`${fmt(price)}\``
  );
});

bot.onText(/\/help/, (msg) => {
  send(msg.chat.id, [
    '*📖 Command Reference*',
    '',
    '/start — Dashboard + subscribe to notifications',
    '/menu — Show main menu',
    '/ads — List your ads',
    '/orders — List your orders',
    '/balance — Account balance',
    '/analytics — 30-day stats',
    '/watch — Subscribe to order alerts',
    '/alert TOKEN CURRENCY SIDE PRICE DIR — Set price alert',
    '  _e.g. /alert USDT NGN SELL 1600 ABOVE_',
    '/alerts — View active alerts',
    '/clearalerts — Remove all alerts',
    '/help — This message',
  ].join('\n'));
});

// ── Ads ───────────────────────────────────────────────────────────────────────
async function showAds(chatId) {
  await send(chatId, '⏳ Loading your ads…');
  let res;
  try { res = await api.getMyAds(); }
  catch (e) { return send(chatId, `❌ Error: ${e.message}`); }

  if (res.retCode !== 0) return send(chatId, `❌ Bybit: ${res.retMsg}`);
  const ads = res.result?.items || [];
  if (!ads.length) return send(chatId, '📭 You have no ads yet.\n\nUse the Mini App to create one.');

  for (const ad of ads.slice(0, 10)) {
    const online = ad.status === 1;
    await bot.sendMessage(chatId,
      `${online ? '🟢' : '⚫'} *${sideLabel(ad.side)} ${ad.tokenId}/${ad.currencyId}*\n` +
      `💲 Price: \`${fmt(ad.price)}\`\n` +
      `📦 Qty: \`${fmt(ad.quantity)}\`\n` +
      `🔢 Limit: \`${fmt(ad.minAmount, 0)} – ${fmt(ad.maxAmount, 0)}\`\n` +
      `🆔 \`${ad.id}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: online ? '⏸ Pause' : '▶️ Activate', callback_data: `ad_toggle_${ad.id}_${ad.status}` },
            { text: '✏️ Edit',   callback_data: `ad_edit_${ad.id}`   },
            { text: '🗑 Delete', callback_data: `ad_del_${ad.id}`    },
          ]],
        },
      }
    );
  }
}

// ── Orders ────────────────────────────────────────────────────────────────────
async function showOrders(chatId, statusFilter = '') {
  await send(chatId, '⏳ Loading orders…');
  let res;
  try { res = await api.getOrders({ status: statusFilter }); }
  catch (e) { return send(chatId, `❌ Error: ${e.message}`); }

  if (res.retCode !== 0) return send(chatId, `❌ Bybit: ${res.retMsg}`);
  const orders = res.result?.items || [];
  if (!orders.length) return send(chatId, '📭 No orders found.');

  for (const o of orders.slice(0, 8)) {
    const btns = [];
    const s    = String(o.status);
    if (s === '10')            btns.push({ text: '✅ Mark Paid',  callback_data: `ord_pay_${o.id}`     });
    if (s === '20')            btns.push({ text: '🔓 Release',    callback_data: `ord_release_${o.id}` });
    if (['5','10'].includes(s)) btns.push({ text: '❌ Cancel',    callback_data: `ord_cancel_${o.id}`  });
    if (['10','20'].includes(s)) btns.push({ text: '💬 Chat',     callback_data: `ord_chat_${o.id}`    });

    await bot.sendMessage(chatId,
      `${statusLabel(o.status)} — *${sideLabel(o.side)}*\n` +
      `💱 ${o.tokenId} / ${o.currencyId}\n` +
      `💲 \`${fmt(o.amount)} ${o.currencyId}\`  📦 \`${fmt(o.quantity, 4)} ${o.tokenId}\`\n` +
      `🕐 ${new Date(Number(o.createDate)).toLocaleString()}\n` +
      `🆔 \`${o.id}\``,
      {
        parse_mode: 'Markdown',
        ...(btns.length ? { reply_markup: { inline_keyboard: [btns] } } : {}),
      }
    );
  }
}

// ── Balance ───────────────────────────────────────────────────────────────────
async function showBalance(chatId) {
  await send(chatId, '⏳ Fetching balance…');
  let res;
  try { res = await api.getAccountBalance(); }
  catch (e) { return send(chatId, `❌ Error: ${e.message}`); }
  if (res.retCode !== 0) return send(chatId, `❌ Bybit: ${res.retMsg}`);

  const coins = (res.result?.list?.[0]?.coin || [])
    .filter(c => parseFloat(c.walletBalance) > 0);

  const lines = coins.map(c =>
    `• *${c.coin}*\n  Wallet: \`${fmt(c.walletBalance, 6)}\`  Available: \`${fmt(c.transferBalance, 6)}\``
  ).join('\n');

  send(chatId, `💰 *Fund Account Balance*\n\n${lines || 'No funds found.'}`);
}

// ── Chat ──────────────────────────────────────────────────────────────────────
async function openOrderChat(chatId, orderId) {
  const sess        = session(chatId);
  sess.chatMode     = true;
  sess.activeOrder  = orderId;

  let res;
  try { res = await api.getChatMessages(orderId, 15); }
  catch (e) { return send(chatId, `❌ Error loading chat: ${e.message}`); }

  const msgs = (res.result?.list || []).slice().reverse();
  const history = msgs.length
    ? msgs.map(m =>
        `*${m.userId === 'me' ? 'You' : 'Counterparty'}* [${new Date(Number(m.createDate)).toLocaleTimeString()}]:\n${m.message}`
      ).join('\n\n')
    : '_No messages yet_';

  await send(chatId,
    `💬 *Chat — Order* \`${orderId}\`\n\n${history}`,
    keyboard([[{ text: '⬅️ Back to orders', callback_data: 'orders_list' }]])
  );
  send(chatId, '✏️ Type your reply and I\'ll send it to the counterparty:');
}

// ── Analytics ─────────────────────────────────────────────────────────────────
async function showAnalytics(chatId) {
  await send(chatId, '⏳ Calculating 30-day analytics…');
  let res;
  try { res = await api.getOrderHistory(30); }
  catch (e) { return send(chatId, `❌ Error: ${e.message}`); }
  if (res.retCode !== 0) return send(chatId, `❌ Bybit: ${res.retMsg}`);

  const all       = res.result?.items || [];
  const done      = all.filter(o => String(o.status) === '30');
  const cancelled = all.filter(o => String(o.status) === '40');
  const appeals   = all.filter(o => String(o.status) === '50');
  const vol       = done.reduce((s, o) => s + parseFloat(o.amount  || 0), 0);
  const qty       = done.reduce((s, o) => s + parseFloat(o.quantity || 0), 0);
  const rate      = all.length ? ((done.length / all.length) * 100).toFixed(1) : '0.0';
  const avgPrice  = qty > 0 ? vol / qty : 0;
  const buys      = done.filter(o => String(o.side) === '0').length;
  const sells     = done.filter(o => String(o.side) === '1').length;

  send(chatId,
    `📊 *Analytics — Last 30 Days*\n\n` +
    `✅ Completed:  *${done.length}* orders\n` +
    `❌ Cancelled:  *${cancelled.length}*\n` +
    `⚠️ Appeals:   *${appeals.length}*\n` +
    `📈 Completion: *${rate}%*\n\n` +
    `💱 Total Volume:  \`${fmt(vol)}\` (fiat)\n` +
    `📦 Total Qty:     \`${fmt(qty, 4)}\` USDT\n` +
    `📊 Avg Price:     \`${fmt(avgPrice)}\`\n\n` +
    `🟢 Buy orders:    *${buys}*\n` +
    `🔴 Sell orders:   *${sells}*`,
    keyboard([[{ text: '🖥️ Full Analytics in Mini App', web_app: { url: `${MINI_APP_URL}#analytics` } }]])
  );
}

// ── Price Alerts ──────────────────────────────────────────────────────────────
function listAlerts(chatId) {
  const list = priceAlerts.get(chatId) || [];
  if (!list.length) {
    return send(chatId,
      '📭 No active price alerts.\n\n' +
      'Set one with:\n`/alert TOKEN CURRENCY SIDE PRICE DIRECTION`\n' +
      'e.g. `/alert USDT NGN SELL 1600 ABOVE`'
    );
  }
  const lines = list.map((a, i) =>
    `${i + 1}. *${a.token}/${a.currency} ${a.side}* — ` +
    `${a.above ? '⬆️ Above' : '⬇️ Below'} \`${fmt(a.targetPrice)}\``
  ).join('\n');
  send(chatId, `🔔 *Active Price Alerts*\n\n${lines}\n\nUse /clearalerts to remove all.`);
}

// ── Callback Queries ──────────────────────────────────────────────────────────
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const data   = q.data;
  bot.answerCallbackQuery(q.id).catch(() => {});

  // Menu items
  if (data === 'ads_list')    return showAds(chatId);
  if (data === 'orders_list') return showOrders(chatId);
  if (data === 'balance')     return showBalance(chatId);
  if (data === 'analytics')   return showAnalytics(chatId);
  if (data === 'chat_menu') {
    return send(chatId,
      '💬 *Chat*\n\nSelect an order from `/orders` and tap the Chat button,\nor use the Mini App for a full chat experience.',
      keyboard([[{ text: '📦 View Orders', callback_data: 'orders_list' }],
                [{ text: '🖥️ Open Mini App', web_app: { url: MINI_APP_URL } }]])
    );
  }
  if (data === 'alerts_menu') {
    return send(chatId,
      '🔔 *Price Alerts*\n\n' +
      'Set: `/alert TOKEN CURRENCY SIDE PRICE DIRECTION`\n' +
      'e.g. `/alert USDT NGN SELL 1600 ABOVE`',
      keyboard([
        [{ text: '📋 My Alerts',    callback_data: 'alerts_list'  }],
        [{ text: '🗑 Clear All',    callback_data: 'alerts_clear' }],
      ])
    );
  }
  if (data === 'alerts_list')  return listAlerts(chatId);
  if (data === 'alerts_clear') {
    priceAlerts.delete(chatId);
    return send(chatId, '✅ All alerts cleared.');
  }

  // Ad: toggle
  if (data.startsWith('ad_toggle_')) {
    const parts     = data.split('_');              // ['ad','toggle', id, status]
    const adId      = parts[2];
    const curStatus = parts[3];
    const newStatus = curStatus === '1' ? '2' : '1';
    try {
      const r = await api.toggleAdStatus(adId, newStatus);
      send(chatId, r.retCode === 0
        ? `✅ Ad ${newStatus === '1' ? 'activated 🟢' : 'paused ⚫'}.`
        : `❌ ${r.retMsg}`
      );
    } catch (e) { send(chatId, `❌ ${e.message}`); }
    return;
  }

  // Ad: edit (deep link to Mini App)
  if (data.startsWith('ad_edit_')) {
    const adId = data.replace('ad_edit_', '');
    return send(chatId, `✏️ Edit this ad in the Mini App:`,
      keyboard([[{ text: '✏️ Edit Ad', web_app: { url: `${MINI_APP_URL}#ads/edit/${adId}` } }]])
    );
  }

  // Ad: delete
  if (data.startsWith('ad_del_')) {
    const adId = data.replace('ad_del_', '');
    try {
      const r = await api.deleteAd(adId);
      send(chatId, r.retCode === 0 ? '🗑 Ad deleted.' : `❌ ${r.retMsg}`);
    } catch (e) { send(chatId, `❌ ${e.message}`); }
    return;
  }

  // Order: pay
  if (data.startsWith('ord_pay_')) {
    const id = data.replace('ord_pay_', '');
    try {
      const r = await api.confirmPayment(id);
      send(chatId, r.retCode === 0 ? '✅ Payment confirmed!' : `❌ ${r.retMsg}`);
    } catch (e) { send(chatId, `❌ ${e.message}`); }
    return;
  }

  // Order: release
  if (data.startsWith('ord_release_')) {
    const id = data.replace('ord_release_', '');
    try {
      const r = await api.releaseAsset(id);
      send(chatId, r.retCode === 0 ? '🔓 Crypto released to buyer!' : `❌ ${r.retMsg}`);
    } catch (e) { send(chatId, `❌ ${e.message}`); }
    return;
  }

  // Order: cancel
  if (data.startsWith('ord_cancel_')) {
    const id = data.replace('ord_cancel_', '');
    try {
      const r = await api.cancelOrder(id, '1');
      send(chatId, r.retCode === 0 ? '❌ Order cancelled.' : `❌ ${r.retMsg}`);
    } catch (e) { send(chatId, `❌ ${e.message}`); }
    return;
  }

  // Order: open chat
  if (data.startsWith('ord_chat_')) {
    const id = data.replace('ord_chat_', '');
    return openOrderChat(chatId, id);
  }
});

// ── Incoming messages (chat mode) ─────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const sess   = session(chatId);
  if (!sess.chatMode || !sess.activeOrder) return;

  try {
    const r = await api.sendChatMessage(sess.activeOrder, msg.text);
    send(chatId, r.retCode === 0 ? '✅ Message sent.' : `❌ ${r.retMsg}`);
  } catch (e) {
    send(chatId, `❌ ${e.message}`);
  }
});

// ── Background: price alert checker (every 2 min) ─────────────────────────────
cron.schedule('*/2 * * * *', async () => {
  for (const [chatId, alerts] of priceAlerts.entries()) {
    for (let i = alerts.length - 1; i >= 0; i--) {
      const a = alerts[i];
      try {
        const r       = await api.getMarketAds({ tokenId: a.token, currencyId: a.currency, side: a.side === 'SELL' ? '0' : '1', size: 1 });
        const topAd   = r.result?.items?.[0];
        if (!topAd) continue;
        const price   = parseFloat(topAd.price);
        const hit     = a.above ? price >= a.targetPrice : price <= a.targetPrice;
        if (hit) {
          send(chatId,
            `🚨 *Price Alert Triggered!*\n\n` +
            `*${a.token}/${a.currency} ${a.side}* is now at *${fmt(price)}*\n` +
            `Your target: ${a.above ? '⬆️ Above' : '⬇️ Below'} ${fmt(a.targetPrice)}`
          );
          alerts.splice(i, 1);
        }
      } catch { /* ignore per-alert errors */ }
    }
  }
});

// ── Background: new order watcher (every 30 sec) ──────────────────────────────
cron.schedule('*/30 * * * * *', async () => {
  if (!orderWatchers.size) return;
  try {
    const r      = await api.getOrders({ status: '5', size: 20 });
    const orders = r.result?.items || [];
    for (const o of orders) {
      const prev = orderSnapshot.get(o.id);
      if (!prev) {
        // Brand new order
        for (const chatId of orderWatchers) {
          send(chatId,
            `🆕 *New Order Arrived!*\n\n` +
            `${sideLabel(o.side)} ${o.tokenId}/${o.currencyId}\n` +
            `💲 \`${fmt(o.amount)} ${o.currencyId}\`\n` +
            `🆔 \`${o.id}\``,
            keyboard([[{ text: '💬 Open Chat', callback_data: `ord_chat_${o.id}` }]])
          );
        }
      } else if (prev.status !== o.status) {
        for (const chatId of orderWatchers) {
          send(chatId,
            `🔄 *Order Updated*\n\`${o.id}\`\n` +
            `${statusLabel(prev.status)} → ${statusLabel(o.status)}`
          );
        }
      }
      orderSnapshot.set(o.id, o);
    }
  } catch { /* ignore poll errors */ }
});

// ── Polling error handler ─────────────────────────────────────────────────────
bot.on('polling_error', (err) => {
  console.error('[polling_error]', err.code, err.message);
});

console.log(`🤖 Bybit P2P Bot started (testnet=${process.env.BYBIT_TESTNET === 'true'})`);
console.log(`📱 Mini App URL: ${MINI_APP_URL}`);

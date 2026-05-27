/**
 * bot/index.js
 * Multi-user Bybit P2P Telegram Bot
 *
 * Every user gets their own Bybit API keys stored in data/users.json.
 * The admin (ADMIN_TELEGRAM_ID) gets extra commands to manage users.
 *
 * User flow:
 *   /start  → welcome + register
 *   /setup  → guided Bybit API key entry
 *   /menu   → main dashboard (requires keys)
 *   ...all existing commands now scoped to req user's own Bybit account
 *
 * Admin-only:
 *   /admin           → admin panel
 *   /users           → list all registered users
 *   /suspend <id>    → suspend a user
 *   /reinstate <id>  → reinstate a user
 *   /deluser <id>    → delete a user
 *   /broadcast <msg> → send message to all active users
 */

'use strict';

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const cron        = require('node-cron');
const path        = require('path');
const store       = require(path.join(__dirname, '../lib/store'));
const pool        = require(path.join(__dirname, '../lib/bybit-pool'));

if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');

const bot         = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const MINI_APP_URL = (process.env.MINI_APP_URL || 'https://your-app.onrender.com').replace(/\/$/, '');
const ADMIN_ID    = Number(process.env.ADMIN_TELEGRAM_ID || 0);

// ── In-memory per-user state ──────────────────────────────────────────────────
const sessions      = new Map(); // chatId → { step, chatMode, activeOrder, ... }
const priceAlerts   = new Map(); // chatId → [{ token, currency, side, targetPrice, above }]
const orderWatchers = new Set(); // chatIds watching for new orders
const orderSnap     = new Map(); // `${userId}:${orderId}` → last status

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n, d = 2) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const sideLabel   = s => String(s) === '0' ? '🟢 BUY' : '🔴 SELL';
const statusLabel = s => ({
  '5':'🔄 In Progress','10':'⏳ Waiting Payment',
  '20':'💳 Paid – Awaiting Release','30':'✅ Completed',
  '40':'❌ Cancelled','50':'⚠️ Appeal',
})[String(s)] || `Status ${s}`;

function sess(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId);
}

async function send(chatId, text, extra = {}) {
  try { return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra }); }
  catch (e) { console.error(`[send] ${chatId}:`, e.message); }
}

function kb(rows) { return { reply_markup: { inline_keyboard: rows } }; }

function getApi(chatId) {
  const user = store.get(chatId);
  if (!user?.apiKey || !user?.apiSecret) return null;
  return pool.getClient(user);
}

function requireUser(chatId) {
  return store.get(chatId);
}

// ── Registration + Setup ──────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;

  // Register user if first time
  let user = store.get(chatId);
  if (!user) {
    user = store.upsert(chatId, {
      firstName: tgUser.first_name || '',
      username:  tgUser.username  || '',
    });
    // Notify admin of new registration
    if (ADMIN_ID && chatId !== ADMIN_ID) {
      send(ADMIN_ID,
        `👤 *New user registered*\n` +
        `Name: ${tgUser.first_name || 'Unknown'}\n` +
        `Username: @${tgUser.username || 'none'}\n` +
        `Telegram ID: \`${chatId}\``
      );
    }
  }

  if (!user.active) {
    return send(chatId, '🚫 Your account has been suspended. Contact the admin.');
  }

  await send(chatId,
    `👋 Welcome, *${tgUser.first_name}*!\n\n` +
    `I'm your personal Bybit P2P merchant assistant.\n\n` +
    (user.apiKey
      ? `✅ Your Bybit API keys are configured. Use /menu to get started.`
      : `⚠️ You need to connect your Bybit account first.\n\nUse /setup to add your API keys.`)
  );
});

bot.onText(/\/setup/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId);
  if (!user) return send(chatId, 'Please /start first.');
  if (!user.active) return send(chatId, '🚫 Account suspended.');

  const session = sess(chatId);
  session.step = 'awaiting_api_key';
  session.pendingTestnet = false;
  send(chatId,
    `🔑 *Bybit API Setup*\n\n` +
    `To connect your Bybit account:\n\n` +
    `1. Go to [bybit.com](https://bybit.com)\n` +
    `2. Account → API Management → Create New Key\n` +
    `3. Enable: *Read* + *Trade* permissions\n` +
    `4. Add your server IP (or leave open for now)\n\n` +
    `*Step 1 of 2 — Paste your API Key:*
` +
    `_Tip: Reply with \`TESTNET\` first if you're connecting a testnet key._`
  );
});

bot.onText(/\/menu/, (msg) => {
  const user = requireUser(msg.chat.id);
  if (!user || !user.active) return send(msg.chat.id, 'Please /start first.');
  if (!user.apiKey) return send(msg.chat.id, '⚠️ Run /setup to connect your Bybit account first.');
  showMenu(msg.chat.id);
});

bot.onText(/\/mykeys/, (msg) => {
  const chatId = msg.chat.id;
  const user   = store.get(chatId);
  if (!user) return send(chatId, 'Please /start first.');
  if (!user.apiKey) return send(chatId, '⚠️ No keys saved. Use /setup.');
  send(chatId,
    `🔑 *Your API Keys*\n\n` +
    `Key: \`${user.apiKey.slice(0,6)}••••••••${user.apiKey.slice(-4)}\`\n` +
    `Testnet: ${user.testnet ? 'Yes' : 'No'}\n` +
    `Saved: ${new Date(user.registeredAt).toLocaleDateString()}`,
    kb([[{ text: '🗑 Remove Keys', callback_data: 'remove_keys' }]])
  );
});

bot.onText(/\/ads/,       (msg) => { const a = getApi(msg.chat.id); a ? showAds(msg.chat.id, a)           : noKeys(msg.chat.id); });
bot.onText(/\/orders/,    (msg) => { const a = getApi(msg.chat.id); a ? showOrders(msg.chat.id, a)        : noKeys(msg.chat.id); });
bot.onText(/\/balance/,   (msg) => { const a = getApi(msg.chat.id); a ? showBalance(msg.chat.id, a)       : noKeys(msg.chat.id); });
bot.onText(/\/analytics/, (msg) => { const a = getApi(msg.chat.id); a ? showAnalytics(msg.chat.id, a)    : noKeys(msg.chat.id); });
bot.onText(/\/alerts/,    (msg) => listAlerts(msg.chat.id));
bot.onText(/\/watch/,     (msg) => { orderWatchers.add(msg.chat.id); send(msg.chat.id, '👁️ Subscribed to order notifications.'); });
bot.onText(/\/clearalerts/, (msg) => { priceAlerts.delete(msg.chat.id); send(msg.chat.id, '✅ Alerts cleared.'); });

bot.onText(/\/alert (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const parts  = match[1].trim().split(/\s+/);
  if (parts.length < 5) {
    return send(chatId, '⚠️ Usage: `/alert TOKEN CURRENCY SIDE PRICE ABOVE|BELOW`\ne.g. `/alert USDT NGN SELL 1600 ABOVE`');
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
  send(chatId, `🔔 Alert set for *${token}/${currency} ${side}* ${dir.toUpperCase() === 'ABOVE' ? '⬆️ above' : '⬇️ below'} \`${fmt(price)}\``);
});

bot.onText(/\/help/, (msg) => {
  const isAdmin = store.isAdmin(msg.chat.id);
  const lines = [
    '*📖 Commands*','',
    '/start — Register / welcome',
    '/setup — Connect your Bybit API keys',
    '/menu — Main dashboard',
    '/mykeys — View / remove your saved keys',
    '/ads — List your ads',
    '/orders — List your orders',
    '/balance — Account balance',
    '/analytics — 30-day stats',
    '/alert TOKEN CURRENCY SIDE PRICE DIR — Set price alert',
    '/alerts — View active alerts',
    '/clearalerts — Remove all alerts',
    '/watch — Subscribe to order push notifications',
  ];
  if (isAdmin) {
    lines.push('', '*👑 Admin Commands*','',
      '/admin — Admin panel',
      '/users — List all users',
      '/suspend <telegramId> — Suspend a user',
      '/reinstate <telegramId> — Reinstate a user',
      '/deluser <telegramId> — Delete a user',
      '/broadcast <message> — Message all active users'
    );
  }
  send(msg.chat.id, lines.join('\n'));
});

function noKeys(chatId) {
  send(chatId, '⚠️ You need to connect your Bybit account first.\nUse /setup to add your API keys.');
}

// ── Main Menu ─────────────────────────────────────────────────────────────────
function showMenu(chatId) {
  return send(chatId, '🏪 *P2P Merchant Hub*\n\nWhat would you like to do?',
    kb([
      [{ text: '📋 My Ads',    callback_data: 'ads_list'    },
       { text: '📦 Orders',    callback_data: 'orders_list' }],
      [{ text: '💬 Chat',      callback_data: 'chat_menu'   },
       { text: '🔔 Alerts',    callback_data: 'alerts_menu' }],
      [{ text: '📊 Analytics', callback_data: 'analytics'   },
       { text: '💰 Balance',   callback_data: 'balance'     }],
      [{ text: '🖥️ Open Mini App', web_app: { url: MINI_APP_URL } }],
    ])
  );
}

// ── Ads ───────────────────────────────────────────────────────────────────────
async function showAds(chatId, api) {
  await send(chatId, '⏳ Loading your ads…');
  try {
    const res = await api.getMyAds();
    if (res.retCode !== 0) return send(chatId, `❌ Bybit: ${res.retMsg}`);
    const ads = res.result?.items || [];
    if (!ads.length) return send(chatId, '📭 No ads. Use the Mini App to create one.');
    for (const ad of ads.slice(0, 8)) {
      const on = String(ad.status) === '1';
      await bot.sendMessage(chatId,
        `${on ? '🟢' : '⚫'} *${sideLabel(ad.side)} ${ad.tokenId}/${ad.currencyId}*\n` +
        `💲 \`${fmt(ad.price)}\`  📦 \`${fmt(ad.quantity)}\`\n` +
        `🔢 \`${fmt(ad.minAmount,0)}–${fmt(ad.maxAmount,0)}\`\n` +
        `🆔 \`${ad.id}\``,
        { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[
          { text: on ? '⏸ Pause':'▶️ Activate', callback_data:`ad_toggle_${ad.id}_${ad.status}` },
          { text: '✏️ Edit',   callback_data:`ad_edit_${ad.id}` },
          { text: '🗑 Delete', callback_data:`ad_del_${ad.id}`  },
        ]]}}
      );
    }
  } catch (e) { send(chatId, `❌ ${e.message}`); }
}

// ── Orders ────────────────────────────────────────────────────────────────────
async function showOrders(chatId, api, statusFilter = '') {
  await send(chatId, '⏳ Loading orders…');
  try {
    const res    = await api.getOrders({ status: statusFilter });
    if (res.retCode !== 0) return send(chatId, `❌ Bybit: ${res.retMsg}`);
    const orders = res.result?.items || [];
    if (!orders.length) return send(chatId, '📭 No orders found.');
    for (const o of orders.slice(0, 8)) {
      const s    = String(o.status);
      const btns = [];
      if (s === '10')             btns.push({ text:'✅ Mark Paid', callback_data:`ord_pay_${o.id}` });
      if (s === '20')             btns.push({ text:'🔓 Release',   callback_data:`ord_release_${o.id}` });
      if (['5','10'].includes(s)) btns.push({ text:'❌ Cancel',    callback_data:`ord_cancel_${o.id}` });
      if (['10','20'].includes(s)) btns.push({ text:'💬 Chat',     callback_data:`ord_chat_${o.id}` });
      await bot.sendMessage(chatId,
        `${statusLabel(o.status)} — *${sideLabel(o.side)}*\n` +
        `💱 ${o.tokenId}/${o.currencyId}\n` +
        `💲 \`${fmt(o.amount)} ${o.currencyId}\`  📦 \`${fmt(o.quantity,4)} ${o.tokenId}\`\n` +
        `🕐 ${new Date(Number(o.createDate)).toLocaleString()}\n` +
        `🆔 \`${o.id}\``,
        { parse_mode:'Markdown', ...(btns.length ? { reply_markup:{ inline_keyboard:[btns] } } : {}) }
      );
    }
  } catch (e) { send(chatId, `❌ ${e.message}`); }
}

// ── Balance ───────────────────────────────────────────────────────────────────
async function showBalance(chatId, api) {
  await send(chatId, '⏳ Fetching balance…');
  try {
    const res   = await api.getAccountBalance();
    if (res.retCode !== 0) return send(chatId, `❌ Bybit: ${res.retMsg}`);
    const coins = (res.result?.list?.[0]?.coin || []).filter(c => parseFloat(c.walletBalance) > 0);
    const lines = coins.map(c => `• *${c.coin}*: \`${fmt(c.walletBalance,6)}\` (avail: \`${fmt(c.transferBalance,6)}\`)`).join('\n');
    send(chatId, `💰 *Fund Balance*\n\n${lines || 'No funds found.'}`);
  } catch (e) { send(chatId, `❌ ${e.message}`); }
}

// ── Analytics ─────────────────────────────────────────────────────────────────
async function showAnalytics(chatId, api) {
  await send(chatId, '⏳ Calculating…');
  try {
    const res  = await api.getOrderHistory(30);
    if (res.retCode !== 0) return send(chatId, `❌ Bybit: ${res.retMsg}`);
    const all  = res.result?.items || [];
    const done = all.filter(o => String(o.status) === '30');
    const vol  = done.reduce((s,o) => s + parseFloat(o.amount||0), 0);
    const qty  = done.reduce((s,o) => s + parseFloat(o.quantity||0), 0);
    const rate = all.length ? ((done.length/all.length)*100).toFixed(1) : '0.0';
    send(chatId,
      `📊 *Analytics — Last 30 Days*\n\n` +
      `✅ Completed: *${done.length}*  ❌ Cancelled: *${all.filter(o=>o.status==='40').length}*\n` +
      `📈 Rate: *${rate}%*\n\n` +
      `💱 Volume: \`${fmt(vol)}\` (fiat)\n` +
      `📦 Qty: \`${fmt(qty,4)}\` USDT\n\n` +
      `🟢 Buys: *${done.filter(o=>String(o.side)==='0').length}*  🔴 Sells: *${done.filter(o=>String(o.side)==='1').length}*`,
      kb([[{ text:'🖥️ Full Stats in Mini App', web_app:{ url:`${MINI_APP_URL}#analytics` } }]])
    );
  } catch (e) { send(chatId, `❌ ${e.message}`); }
}

// ── Chat ──────────────────────────────────────────────────────────────────────
async function openOrderChat(chatId, orderId) {
  const api = getApi(chatId);
  if (!api) return noKeys(chatId);
  const s = sess(chatId);
  s.chatMode   = true;
  s.activeOrder = orderId;
  try {
    const res  = await api.getChatMessages(orderId, 15);
    const msgs = (res.result?.list || []).slice().reverse();
    const hist = msgs.map(m =>
      `*${m.isSelf||m.userId==='me'?'You':'Counterparty'}* [${new Date(Number(m.createDate)).toLocaleTimeString()}]:\n${m.message||m.content||''}`
    ).join('\n\n');
    await send(chatId, `💬 *Chat — Order* \`${orderId}\`\n\n${hist||'_No messages yet_'}`, kb([[{text:'⬅️ Back',callback_data:'orders_list'}]]));
    send(chatId, '✏️ Type your message to send it to the counterparty:');
  } catch (e) { send(chatId, `❌ ${e.message}`); }
}

// ── Price Alerts ──────────────────────────────────────────────────────────────
function listAlerts(chatId) {
  const list = priceAlerts.get(chatId) || [];
  if (!list.length) return send(chatId, '📭 No alerts. Use `/alert TOKEN CURRENCY SIDE PRICE ABOVE|BELOW`');
  const lines = list.map((a,i) =>
    `${i+1}. *${a.token}/${a.currency} ${a.side}* ${a.above?'⬆️ Above':'⬇️ Below'} \`${fmt(a.targetPrice)}\``
  ).join('\n');
  send(chatId, `🔔 *Active Alerts*\n\n${lines}\n\n/clearalerts to remove all.`);
}

// ── Admin Commands ────────────────────────────────────────────────────────────
bot.onText(/\/admin/, (msg) => {
  if (!store.isAdmin(msg.chat.id)) return;
  const users   = store.getAll();
  const active  = users.filter(u => u.active).length;
  const withKey = users.filter(u => u.apiKey).length;
  send(msg.chat.id,
    `👑 *Admin Panel*\n\n` +
    `👥 Total users:  *${users.length}*\n` +
    `✅ Active:        *${active}*\n` +
    `🔑 With API keys: *${withKey}*`,
    kb([
      [{ text:'👥 List Users',    callback_data:'admin_users'     }],
      [{ text:'📊 Platform Stats',callback_data:'admin_stats'     }],
      [{ text:'📢 Broadcast',     callback_data:'admin_broadcast' }],
    ])
  );
});

bot.onText(/\/users/, (msg) => {
  if (!store.isAdmin(msg.chat.id)) return;
  const users = store.getAll();
  if (!users.length) return send(msg.chat.id, '📭 No users yet.');
  const lines = users.map(u =>
    `• *${u.firstName||'?'}* @${u.username||'none'} \`${u.telegramId}\` ` +
    `${u.active?'✅':'🚫'} ${u.apiKey?'🔑':'❌'}`
  ).join('\n');
  send(msg.chat.id, `👥 *Registered Users*\n\n${lines}`);
});

bot.onText(/\/suspend (\d+)/, (msg, match) => {
  if (!store.isAdmin(msg.chat.id)) return;
  const targetId = match[1];
  if (store.isAdmin(targetId)) return send(msg.chat.id, '❌ Cannot suspend admin.');
  const u = store.get(targetId);
  if (!u) return send(msg.chat.id, '❌ User not found.');
  store.setActive(targetId, false);
  send(msg.chat.id, `🚫 User \`${targetId}\` (${u.firstName}) suspended.`);
  send(Number(targetId), '🚫 Your account has been suspended by the admin.');
});

bot.onText(/\/reinstate (\d+)/, (msg, match) => {
  if (!store.isAdmin(msg.chat.id)) return;
  const targetId = match[1];
  const u = store.get(targetId);
  if (!u) return send(msg.chat.id, '❌ User not found.');
  store.setActive(targetId, true);
  send(msg.chat.id, `✅ User \`${targetId}\` (${u.firstName}) reinstated.`);
  send(Number(targetId), '✅ Your account has been reinstated. Use /menu to continue.');
});

bot.onText(/\/deluser (\d+)/, (msg, match) => {
  if (!store.isAdmin(msg.chat.id)) return;
  const targetId = match[1];
  if (store.isAdmin(targetId)) return send(msg.chat.id, '❌ Cannot delete admin.');
  const u = store.get(targetId);
  if (!u) return send(msg.chat.id, '❌ User not found.');
  pool.evict(Number(targetId));
  store.remove(targetId);
  send(msg.chat.id, `🗑 User \`${targetId}\` (${u.firstName}) deleted.`);
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!store.isAdmin(msg.chat.id)) return;
  const text  = match[1];
  const users = store.getAll().filter(u => u.active);
  let sent = 0, failed = 0;
  for (const u of users) {
    try { await send(u.telegramId, `📢 *Admin Broadcast*\n\n${text}`); sent++; }
    catch { failed++; }
  }
  send(msg.chat.id, `📢 Broadcast sent: ✅ ${sent} delivered, ❌ ${failed} failed.`);
});

// ── Callback Queries ──────────────────────────────────────────────────────────
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const data   = q.data;
  bot.answerCallbackQuery(q.id).catch(() => {});

  const api = getApi(chatId);

  // Setup / keys
  if (data === 'remove_keys') {
    pool.evict(chatId);
    store.upsert(chatId, { apiKey:'', apiSecret:'' });
    return send(chatId, '🗑 API keys removed. Use /setup to add new ones.');
  }

  // Menu
  if (data === 'menu_home')    return api ? showMenu(chatId)             : noKeys(chatId);
  if (data === 'ads_list')     return api ? showAds(chatId, api)          : noKeys(chatId);
  if (data === 'orders_list')  return api ? showOrders(chatId, api)       : noKeys(chatId);
  if (data === 'balance')      return api ? showBalance(chatId, api)      : noKeys(chatId);
  if (data === 'analytics')    return api ? showAnalytics(chatId, api)    : noKeys(chatId);

  if (data === 'chat_menu') {
    return send(chatId,'💬 Select an order via /orders then tap Chat, or open the Mini App.',
      kb([[{text:'🖥️ Open Mini App',web_app:{url:MINI_APP_URL}}]]));
  }

  if (data === 'alerts_menu') {
    return send(chatId,'🔔 *Price Alerts*\n\nUsage: `/alert TOKEN CURRENCY SIDE PRICE ABOVE|BELOW`',
      kb([[{text:'📋 My Alerts',callback_data:'alerts_list'},{text:'🗑 Clear All',callback_data:'alerts_clear'}]]));
  }
  if (data === 'alerts_list')  return listAlerts(chatId);
  if (data === 'alerts_clear') { priceAlerts.delete(chatId); return send(chatId,'✅ Alerts cleared.'); }

  // Admin callbacks
  if (data === 'admin_users') {
    if (!store.isAdmin(chatId)) return;
    const users = store.getAll();
    const lines = users.map(u =>
      `• *${u.firstName||'?'}* \`${u.telegramId}\` ${u.active?'✅':'🚫'} ${u.apiKey?'🔑':'❌'}`
    ).join('\n');
    return send(chatId, `👥 *Users*\n\n${lines||'None yet.'}`);
  }
  if (data === 'admin_stats') {
    if (!store.isAdmin(chatId)) return;
    const users = store.getAll();
    return send(chatId,
      `📊 *Platform Stats*\n\n` +
      `Total: *${users.length}*\n` +
      `Active: *${users.filter(u=>u.active).length}*\n` +
      `With Keys: *${users.filter(u=>u.apiKey).length}*`
    );
  }
  if (data === 'admin_broadcast') {
    if (!store.isAdmin(chatId)) return;
    sess(chatId).step = 'awaiting_broadcast';
    return send(chatId,'📢 Type the message you want to broadcast to all active users:');
  }

  // Ad toggle — parse right-to-left to handle IDs with underscores
  if (data.startsWith('ad_toggle_')) {
    if (!api) return noKeys(chatId);
    const raw   = data.slice('ad_toggle_'.length);
    const last  = raw.lastIndexOf('_');
    const adId  = raw.slice(0, last);
    const cur   = raw.slice(last + 1);
    const next  = cur === '1' ? '2' : '1';
    try {
      const r = await api.toggleAdStatus(adId, next);
      send(chatId, r.retCode===0 ? `✅ Ad ${next==='1'?'activated 🟢':'paused ⚫'}.` : `❌ ${r.retMsg}`);
    } catch (e) { send(chatId,`❌ ${e.message}`); }
    return;
  }

  if (data.startsWith('ad_edit_')) {
    const adId = data.replace('ad_edit_','');
    return send(chatId,'✏️ Edit in Mini App:',kb([[{text:'✏️ Edit Ad',web_app:{url:`${MINI_APP_URL}#ads/edit/${adId}`}}]]));
  }

  if (data.startsWith('ad_del_')) {
    if (!api) return noKeys(chatId);
    const adId = data.replace('ad_del_','');
    try {
      const r = await api.deleteAd(adId);
      send(chatId, r.retCode===0?'🗑 Ad deleted.': `❌ ${r.retMsg}`);
    } catch(e) { send(chatId,`❌ ${e.message}`); }
    return;
  }

  if (data.startsWith('ord_pay_')) {
    if (!api) return noKeys(chatId);
    try { const r=await api.confirmPayment(data.replace('ord_pay_','')); send(chatId,r.retCode===0?'✅ Payment confirmed!': `❌ ${r.retMsg}`); }
    catch(e){send(chatId,`❌ ${e.message}`);}
    return;
  }
  if (data.startsWith('ord_release_')) {
    if (!api) return noKeys(chatId);
    try { const r=await api.releaseAsset(data.replace('ord_release_','')); send(chatId,r.retCode===0?'🔓 Crypto released!': `❌ ${r.retMsg}`); }
    catch(e){send(chatId,`❌ ${e.message}`);}
    return;
  }
  if (data.startsWith('ord_cancel_')) {
    if (!api) return noKeys(chatId);
    try { const r=await api.cancelOrder(data.replace('ord_cancel_',''),'1'); send(chatId,r.retCode===0?'❌ Order cancelled.': `❌ ${r.retMsg}`); }
    catch(e){send(chatId,`❌ ${e.message}`);}
    return;
  }
  if (data.startsWith('ord_chat_')) {
    return openOrderChat(chatId, data.replace('ord_chat_',''));
  }
});

// ── Multi-step text input handler ─────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const s      = sess(chatId);
  const text   = msg.text.trim();

  // ── API key setup flow ──
  if (s.step === 'awaiting_api_key') {
    if (text.toLowerCase() === 'testnet') {
      s.pendingTestnet = true;
      return send(chatId, '✅ Testnet mode enabled. Now paste your API Key:');
    }
    s.pendingKey = text;
    s.step       = 'awaiting_api_secret';
    return send(chatId, '✅ API Key saved.\n\n*Step 2 of 2 — Paste your API Secret:*');
  }

  if (s.step === 'awaiting_api_secret') {
    const apiKey    = s.pendingKey;
    const apiSecret = text;
    const testnet   = s.pendingTestnet === true;
    delete s.pendingKey;
    delete s.pendingTestnet;
    s.step = null;
    pool.evict(chatId);
    store.upsert(chatId, { apiKey, apiSecret, testnet });
    await send(chatId,
      `✅ *Bybit API Keys Saved!*\n\n` +
      `Your account is now connected. Use /menu to start trading.`,
      kb([[{ text:'🏪 Open Dashboard', callback_data:'menu_home' }],
          [{ text:'🖥️ Open Mini App',  web_app:{ url: MINI_APP_URL } }]])
    );
    // Notify admin
    if (ADMIN_ID && chatId !== ADMIN_ID) {
      const u = store.get(chatId);
      send(ADMIN_ID, `🔑 *User connected Bybit keys*\n${u?.firstName||'?'} \`${chatId}\``);
    }
    return;
  }

  // ── Broadcast step (admin) ──
  if (s.step === 'awaiting_broadcast' && store.isAdmin(chatId)) {
    s.step = null;
    const users = store.getAll().filter(u => u.active && u.telegramId !== chatId);
    let sent = 0, failed = 0;
    for (const u of users) {
      try { await send(u.telegramId, `📢 *Message from Admin*\n\n${text}`); sent++; }
      catch { failed++; }
    }
    return send(chatId, `📢 Sent: ✅ ${sent}, ❌ ${failed}`);
  }

  // ── Chat mode (reply in order chat) ──
  if (s.chatMode && s.activeOrder) {
    const api = getApi(chatId);
    if (!api) return noKeys(chatId);
    try {
      const r = await api.sendChatMessage(s.activeOrder, text);
      send(chatId, r.retCode===0 ? '✅ Sent.' : `❌ ${r.retMsg}`);
    } catch(e) { send(chatId, `❌ ${e.message}`); }
  }
});

// ── Background: price alert checker every 2 min ───────────────────────────────
cron.schedule('*/2 * * * *', async () => {
  for (const [chatId, alerts] of priceAlerts.entries()) {
    const api = getApi(chatId);
    if (!api) continue;
    for (let i = alerts.length - 1; i >= 0; i--) {
      const a = alerts[i];
      try {
        const r   = await api.getMarketAds({ tokenId:a.token, currencyId:a.currency, side:a.side==='SELL'?'0':'1', size:1 });
        const top = r.result?.items?.[0];
        if (!top) continue;
        const p   = parseFloat(top.price);
        const hit = a.above ? p >= a.targetPrice : p <= a.targetPrice;
        if (hit) {
          send(chatId, `🚨 *Alert!*\n*${a.token}/${a.currency} ${a.side}* is now *${fmt(p)}*\n(Target: ${a.above?'⬆️ Above':'⬇️ Below'} ${fmt(a.targetPrice)})`);
          alerts.splice(i, 1);
        }
      } catch {}
    }
  }
});

// ── Background: new order watcher every 30s ───────────────────────────────────
cron.schedule('*/30 * * * * *', async () => {
  for (const chatId of orderWatchers) {
    const api = getApi(chatId);
    if (!api) continue;
    try {
      const r = await api.getOrders({ status:'5', size:20 });
      for (const o of r.result?.items || []) {
        const snapKey = `${chatId}:${o.id}`;
        const prev    = orderSnap.get(snapKey);
        if (!prev) {
          send(chatId,
            `🆕 *New Order!*\n${sideLabel(o.side)} ${o.tokenId}/${o.currencyId}\n` +
            `💲 \`${fmt(o.amount)} ${o.currencyId}\`\n🆔 \`${o.id}\``,
            kb([[{text:'💬 Chat',callback_data:`ord_chat_${o.id}`}]])
          );
        } else if (prev.status !== o.status) {
          send(chatId, `🔄 Order \`${o.id}\`\n${statusLabel(prev.status)} → ${statusLabel(o.status)}`);
        }
        orderSnap.set(snapKey, o);
      }
    } catch {}
  }
});

bot.on('polling_error', e => console.error('[polling]', e.code, e.message));
console.log('🤖 Multi-user P2P Bot started');
console.log(`👑 Admin ID: ${ADMIN_ID || 'NOT SET'}`);
console.log(`📱 Mini App: ${MINI_APP_URL}`);

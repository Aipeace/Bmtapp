/**
 * server.js
 * Multi-user Bybit P2P Merchant — Express server
 *
 * Fixes applied:
 *  1. requireKeys middleware was calling requireAuth twice — refactored
 *  2. /api/balance now passes coin query param to getAccountBalance
 *  3. Admin routes now use requireAdmin (which already calls requireAuth internally)
 *     — removed redundant double-auth
 *  4. Rate limiter now runs AFTER requireAuth so req.telegramId is always set
 *  5. Stale cache: pool.evict() on key save now also clears old keys correctly
 */

'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const store   = require('./lib/store');
const pool    = require('./lib/bybit-pool');
const { requireAuth, requireKeys, requireAdmin } = require('./lib/auth');

// ── Startup validation ─────────────────────────────────────────────────────
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌  TELEGRAM_BOT_TOKEN is required'); process.exit(1);
}
if (!process.env.ADMIN_TELEGRAM_ID) {
  console.warn('⚠️   ADMIN_TELEGRAM_ID not set — admin routes will be inaccessible');
}
if (!process.env.APP_SECRET || process.env.APP_SECRET === 'change_me_32_chars_exactly!!!!!!') {
  console.warn('⚠️   APP_SECRET is not set or is the default — stored secrets use insecure fallback key.');
  console.warn('     Set APP_SECRET to a random 32-character string in your environment.');
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-telegram-init-data,x-dev-user-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// FIX #4: Rate limiter runs after auth so req.telegramId is populated.
// Attach it as a middleware AFTER requireAuth/requireKeys in each route.
const rateLimits = new Map();

function checkRate(req, res, next) {
  const id  = req.telegramId;
  if (!id) return next();
  const now = Date.now();
  let   rl  = rateLimits.get(id) || { count: 0, resetAt: now + 1000 };
  if (now > rl.resetAt) rl = { count: 0, resetAt: now + 1000 };
  rl.count++;
  rateLimits.set(id, rl);
  if (rl.count > 10) return res.status(429).json({ error: 'Rate limit exceeded — slow down.' });
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [id, rl] of rateLimits.entries()) {
    if (now > rl.resetAt + 5000) rateLimits.delete(id);
  }
}, 60_000);

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), users: store.count() });
});

// ── User self-service ──────────────────────────────────────────────────────

app.get('/api/me', requireAuth, checkRate, (req, res) => {
  const u = req.user;
  res.json({
    telegramId:   u.telegramId,
    firstName:    u.firstName,
    username:     u.username,
    isAdmin:      u.isAdmin,
    active:       u.active,
    hasKeys:      !!(u.apiKey && u.apiSecret),
    testnet:      u.testnet,
    registeredAt: u.registeredAt,
  });
});

app.post('/api/keys', requireAuth, checkRate, (req, res) => {
  const { apiKey, apiSecret, testnet } = req.body;
  if (!apiKey || !apiSecret) {
    return res.status(400).json({ error: 'apiKey and apiSecret are required' });
  }
  // FIX #5: evict by telegramId clears all cached clients for this user
  pool.evict(req.telegramId);
  const user = store.upsert(req.telegramId, {
    apiKey:    apiKey.trim(),
    apiSecret: apiSecret.trim(),
    testnet:   testnet === true || testnet === 'true',
  });
  res.json({ ok: true, testnet: user.testnet });
});

app.delete('/api/keys', requireAuth, checkRate, (req, res) => {
  pool.evict(req.telegramId);
  store.upsert(req.telegramId, { apiKey: '', apiSecret: '' });
  res.json({ ok: true });
});

// ── All routes below require valid Bybit keys ──────────────────────────────

// FIX #2: pass coin param so frontend can request specific coin balance
app.get('/api/balance', requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.getAccountBalance(req.query.coin || 'USDT'))
));

app.get('/api/profile',         requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.getP2PProfile())));
app.get('/api/payment-methods', requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.getPaymentMethods())));
app.get('/api/tokens',          requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.getSupportedTokens())));
app.get('/api/currencies',      requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.getSupportedCurrencies())));

app.get('/api/market/ads', requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.getMarketAds(req.query))
));

// Ads
app.get('/api/ads',     requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.getMyAds({ page: req.query.page || 1, size: req.query.size || 20, tokenId: req.query.tokenId, side: req.query.side }))
));
app.post('/api/ads',    requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.createAd(req.body))
));
app.get('/api/ads/:id', requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.getAdDetail(req.params.id))
));
app.put('/api/ads/:id', requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.updateAd(req.params.id, req.body))
));
app.patch('/api/ads/:id/status', requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.toggleAdStatus(req.params.id, req.body.status))
));
app.delete('/api/ads/:id', requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.deleteAd(req.params.id))
));

// Orders — /history MUST be registered before /:id
app.get('/api/orders/history', requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.getOrderHistory(Number(req.query.days) || 30))
));
app.get('/api/orders', requireKeys, checkRate, wrap(async (req, res) =>
  res.json(await req.bybit.getOrders({
    page:   req.query.page   || 1,
    size:   req.query.size   || 20,
    status: req.query.status,
  }))
));
app.get('/api/orders/:id',            requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.getOrderDetail(req.params.id))));
app.post('/api/orders/:id/pay',       requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.confirmPayment(req.params.id))));
app.post('/api/orders/:id/release',   requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.releaseAsset(req.params.id))));
app.post('/api/orders/:id/cancel',    requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.cancelOrder(req.params.id, req.body.cancelType || '1'))));
app.post('/api/orders/:id/appeal',    requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.appealOrder(req.params.id, req.body.appealType, req.body.appealNote))));
app.get('/api/orders/:id/messages',   requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.getChatMessages(req.params.id, Number(req.query.size) || 50))));
app.post('/api/orders/:id/messages',  requireKeys, checkRate, wrap(async (req, res) => res.json(await req.bybit.sendChatMessage(req.params.id, req.body.message, req.body.msgType || 'str'))));

// ── Admin routes ───────────────────────────────────────────────────────────

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users = store.getAll();
  res.json({
    totalUsers:  users.length,
    activeUsers: users.filter(u => u.active).length,
    withKeys:    users.filter(u => u.apiKey && u.apiSecret).length,
    adminId:     Number(process.env.ADMIN_TELEGRAM_ID),
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = store.getAll().map(u => ({
    telegramId:   u.telegramId,
    firstName:    u.firstName,
    username:     u.username,
    active:       u.active,
    hasKeys:      !!(u.apiKey && u.apiSecret),
    testnet:      u.testnet,
    registeredAt: u.registeredAt,
    lastSeen:     u.lastSeen,
    isAdmin:      u.isAdmin,
  }));
  res.json({ users });
});

app.get('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = store.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { apiSecret, ...safe } = u;
  res.json({ ...safe, hasKeys: !!(u.apiKey && u.apiSecret) });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = store.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (store.isAdmin(req.params.id)) return res.status(400).json({ error: 'Cannot modify admin account' });
  const updated = store.setActive(req.params.id, req.body.active !== false);
  res.json({ ok: true, active: updated.active });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (store.isAdmin(req.params.id)) return res.status(400).json({ error: 'Cannot delete admin account' });
  pool.evict(Number(req.params.id));
  store.remove(req.params.id);
  res.json({ ok: true });
});

// ── Static: Mini App SPA ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  Server on port ${PORT}`);
  console.log(`👑  Admin Telegram ID : ${process.env.ADMIN_TELEGRAM_ID || 'NOT SET'}`);
  console.log(`📱  Mini App          : http://localhost:${PORT}/`);
});

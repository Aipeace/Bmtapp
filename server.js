/**
 * server.js
 * Multi-user Bybit P2P Merchant — Express server for Render
 *
 * Routes:
 *   /                         → public/index.html  (Mini App)
 *   /api/me                   → current user profile + keys status
 *   /api/keys                 → save / delete Bybit keys
 *   /api/balance              → user's Bybit balance
 *   /api/profile              → user's P2P profile
 *   /api/payment-methods
 *   /api/tokens
 *   /api/currencies
 *   /api/market/ads
 *   /api/ads                  → CRUD
 *   /api/orders               → list + actions
 *   /api/orders/history
 *   /api/orders/:id
 *   /api/orders/:id/pay|release|cancel|appeal
 *   /api/orders/:id/messages  → chat
 *   /api/admin/users          → [ADMIN] list all users
 *   /api/admin/users/:id      → [ADMIN] get / suspend / delete user
 *   /api/admin/stats          → [ADMIN] platform stats
 */

'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const store   = require('./lib/store');
const pool    = require('./lib/bybit-pool');
const { requireAuth, requireKeys, requireAdmin } = require('./lib/auth');

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌  TELEGRAM_BOT_TOKEN is required'); process.exit(1);
}
if (!process.env.ADMIN_TELEGRAM_ID) {
  console.warn('⚠️   ADMIN_TELEGRAM_ID not set — admin routes will be inaccessible');
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-telegram-init-data,x-dev-user-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), users: store.count() });
});

// ── User self-service ─────────────────────────────────────────────────────────

/* GET /api/me — returns user record + whether keys are set */
app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    telegramId:  u.telegramId,
    firstName:   u.firstName,
    username:    u.username,
    isAdmin:     u.isAdmin,
    active:      u.active,
    hasKeys:     !!(u.apiKey && u.apiSecret),
    testnet:     u.testnet,
    registeredAt: u.registeredAt,
  });
});

/* POST /api/keys — save or update Bybit API keys */
app.post('/api/keys', requireAuth, (req, res) => {
  const { apiKey, apiSecret, testnet } = req.body;
  if (!apiKey || !apiSecret) {
    return res.status(400).json({ error: 'apiKey and apiSecret are required' });
  }
  pool.evict(req.telegramId); // clear cached client so new keys take effect
  const user = store.upsert(req.telegramId, {
    apiKey:    apiKey.trim(),
    apiSecret: apiSecret.trim(),
    testnet:   testnet === true || testnet === 'true',
  });
  res.json({ ok: true, testnet: user.testnet });
});

/* DELETE /api/keys — remove saved keys */
app.delete('/api/keys', requireAuth, (req, res) => {
  pool.evict(req.telegramId);
  store.upsert(req.telegramId, { apiKey: '', apiSecret: '' });
  res.json({ ok: true });
});

// ── All routes below require valid Bybit keys ─────────────────────────────────

/* Account */
app.get('/api/balance',         requireKeys, wrap(async (req, res) => res.json(await req.bybit.getAccountBalance())));
app.get('/api/profile',         requireKeys, wrap(async (req, res) => res.json(await req.bybit.getP2PProfile())));
app.get('/api/payment-methods', requireKeys, wrap(async (req, res) => res.json(await req.bybit.getPaymentMethods())));
app.get('/api/tokens',          requireKeys, wrap(async (req, res) => res.json(await req.bybit.getSupportedTokens())));
app.get('/api/currencies',      requireKeys, wrap(async (req, res) => res.json(await req.bybit.getSupportedCurrencies())));

/* Market */
app.get('/api/market/ads', requireKeys, wrap(async (req, res) => res.json(await req.bybit.getMarketAds(req.query))));

/* Ads */
app.get('/api/ads',     requireKeys, wrap(async (req, res) => res.json(await req.bybit.getMyAds({ page: req.query.page || 1, size: req.query.size || 20 }))));
app.post('/api/ads',    requireKeys, wrap(async (req, res) => res.json(await req.bybit.createAd(req.body))));
app.get('/api/ads/:id', requireKeys, wrap(async (req, res) => res.json(await req.bybit.getAdDetail(req.params.id))));
app.put('/api/ads/:id', requireKeys, wrap(async (req, res) => res.json(await req.bybit.updateAd(req.params.id, req.body))));
app.patch('/api/ads/:id/status', requireKeys, wrap(async (req, res) => res.json(await req.bybit.toggleAdStatus(req.params.id, req.body.status))));
app.delete('/api/ads/:id', requireKeys, wrap(async (req, res) => res.json(await req.bybit.deleteAd(req.params.id))));

/* Orders — /history MUST come before /:id */
app.get('/api/orders/history', requireKeys, wrap(async (req, res) => res.json(await req.bybit.getOrderHistory(Number(req.query.days) || 30))));
app.get('/api/orders',         requireKeys, wrap(async (req, res) => res.json(await req.bybit.getOrders({ page: req.query.page || 1, size: req.query.size || 20, status: req.query.status || '' }))));
app.get('/api/orders/:id',     requireKeys, wrap(async (req, res) => res.json(await req.bybit.getOrderDetail(req.params.id))));
app.post('/api/orders/:id/pay',     requireKeys, wrap(async (req, res) => res.json(await req.bybit.confirmPayment(req.params.id))));
app.post('/api/orders/:id/release', requireKeys, wrap(async (req, res) => res.json(await req.bybit.releaseAsset(req.params.id))));
app.post('/api/orders/:id/cancel',  requireKeys, wrap(async (req, res) => res.json(await req.bybit.cancelOrder(req.params.id, req.body.cancelType || '1'))));
app.post('/api/orders/:id/appeal',  requireKeys, wrap(async (req, res) => res.json(await req.bybit.appealOrder(req.params.id, req.body.appealType, req.body.appealNote))));

/* Chat */
app.get('/api/orders/:id/messages',  requireKeys, wrap(async (req, res) => res.json(await req.bybit.getChatMessages(req.params.id, Number(req.query.size) || 50))));
app.post('/api/orders/:id/messages', requireKeys, wrap(async (req, res) => res.json(await req.bybit.sendChatMessage(req.params.id, req.body.message, req.body.msgType || 'str'))));

// ── Admin routes ──────────────────────────────────────────────────────────────

/* GET /api/admin/stats */
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users   = store.getAll();
  const active  = users.filter(u => u.active);
  const withKeys = users.filter(u => u.apiKey && u.apiSecret);
  res.json({
    totalUsers:  users.length,
    activeUsers: active.length,
    withKeys:    withKeys.length,
    adminId:     Number(process.env.ADMIN_TELEGRAM_ID),
  });
});

/* GET /api/admin/users */
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = store.getAll().map(u => ({
    telegramId:  u.telegramId,
    firstName:   u.firstName,
    username:    u.username,
    active:      u.active,
    hasKeys:     !!(u.apiKey && u.apiSecret),
    testnet:     u.testnet,
    registeredAt: u.registeredAt,
    lastSeen:    u.lastSeen,
    isAdmin:     u.isAdmin,
  }));
  res.json({ users });
});

/* GET /api/admin/users/:id */
app.get('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = store.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  // Never expose raw API secret to admin panel
  const { apiSecret, ...safe } = u;
  res.json({ ...safe, hasKeys: !!(u.apiKey && u.apiSecret) });
});

/* PATCH /api/admin/users/:id  — suspend or reinstate */
app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = store.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (store.isAdmin(req.params.id)) return res.status(400).json({ error: 'Cannot modify admin account' });
  const updated = store.setActive(req.params.id, req.body.active !== false);
  res.json({ ok: true, active: updated.active });
});

/* DELETE /api/admin/users/:id */
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (store.isAdmin(req.params.id)) return res.status(400).json({ error: 'Cannot delete admin account' });
  pool.evict(Number(req.params.id));
  store.remove(req.params.id);
  res.json({ ok: true });
});

// ── Static: serve Mini App (SPA catch-all) ────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  Server on port ${PORT}`);
  console.log(`👑  Admin Telegram ID : ${process.env.ADMIN_TELEGRAM_ID || 'NOT SET'}`);
  console.log(`📱  Mini App          : http://localhost:${PORT}/`);
});

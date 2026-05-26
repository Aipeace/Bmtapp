/**
 * server.js
 * Express web server for Render deployment
 *
 * Serves:
 *   /          →  public/index.html  (Telegram Mini App)
 *   /api/*     →  Bybit P2P API proxy
 *
 * Start: node server.js
 */

'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const BybitP2PApi = require('./lib/bybit-api');

// ── Guards ────────────────────────────────────────────────────────────────────
if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
  console.error('❌  BYBIT_API_KEY and BYBIT_API_SECRET must be set in environment variables.');
  process.exit(1);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

const bybit = new BybitP2PApi(
  process.env.BYBIT_API_KEY,
  process.env.BYBIT_API_SECRET,
  process.env.BYBIT_TESTNET === 'true'
);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS — allow Telegram WebApp origins
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-telegram-init-data');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Telegram init-data validation (optional, enable in production) ─────────────
/*
function validateTgInitData(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'Missing Telegram init data' });

  const params = new URLSearchParams(initData);
  const hash   = params.get('hash');
  params.delete('hash');
  const checkStr = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const expected  = crypto.createHmac('sha256', secretKey)
    .update(checkStr).digest('hex');

  if (expected !== hash) return res.status(401).json({ error: 'Invalid Telegram data' });
  next();
}
app.use('/api', validateTgInitData);
*/

// ── Helpers ───────────────────────────────────────────────────────────────────
const ok  = (res, data) => res.json(data);
const err = (res, e, code = 500) =>
  res.status(code).json({ error: e?.message || String(e) });

// ── API routes ────────────────────────────────────────────────────────────────

// Health
app.get('/api/health', (req, res) => {
  ok(res, { ok: true, ts: Date.now(), testnet: process.env.BYBIT_TESTNET === 'true' });
});

// ── Account ──
app.get('/api/balance', async (req, res) => {
  try { ok(res, await bybit.getAccountBalance()); }
  catch (e) { err(res, e); }
});

app.get('/api/profile', async (req, res) => {
  try { ok(res, await bybit.getP2PProfile()); }
  catch (e) { err(res, e); }
});

app.get('/api/payment-methods', async (req, res) => {
  try { ok(res, await bybit.getPaymentMethods()); }
  catch (e) { err(res, e); }
});

app.get('/api/tokens', async (req, res) => {
  try { ok(res, await bybit.getSupportedTokens()); }
  catch (e) { err(res, e); }
});

app.get('/api/currencies', async (req, res) => {
  try { ok(res, await bybit.getSupportedCurrencies()); }
  catch (e) { err(res, e); }
});

// ── Market ──
app.get('/api/market/ads', async (req, res) => {
  try { ok(res, await bybit.getMarketAds(req.query)); }
  catch (e) { err(res, e); }
});

// ── Ads ──
// IMPORTANT: /ads/history would conflict with /ads/:id — no such route exists, but
// place specific routes BEFORE parameterised ones as a safety habit.
app.get('/api/ads', async (req, res) => {
  try {
    ok(res, await bybit.getMyAds({
      page:    req.query.page    || 1,
      size:    req.query.size    || 20,
      tokenId: req.query.tokenId,
      side:    req.query.side,
    }));
  } catch (e) { err(res, e); }
});

app.post('/api/ads', async (req, res) => {
  try { ok(res, await bybit.createAd(req.body)); }
  catch (e) { err(res, e); }
});

app.get('/api/ads/:id', async (req, res) => {
  try { ok(res, await bybit.getAdDetail(req.params.id)); }
  catch (e) { err(res, e); }
});

app.put('/api/ads/:id', async (req, res) => {
  try { ok(res, await bybit.updateAd(req.params.id, req.body)); }
  catch (e) { err(res, e); }
});

app.patch('/api/ads/:id/status', async (req, res) => {
  try { ok(res, await bybit.toggleAdStatus(req.params.id, req.body.status)); }
  catch (e) { err(res, e); }
});

app.delete('/api/ads/:id', async (req, res) => {
  try { ok(res, await bybit.deleteAd(req.params.id)); }
  catch (e) { err(res, e); }
});

// ── Orders ──
// /api/orders/history MUST come before /api/orders/:id
app.get('/api/orders/history', async (req, res) => {
  try { ok(res, await bybit.getOrderHistory(Number(req.query.days) || 30)); }
  catch (e) { err(res, e); }
});

app.get('/api/orders', async (req, res) => {
  try {
    ok(res, await bybit.getOrders({
      page:   req.query.page   || 1,
      size:   req.query.size   || 20,
      status: req.query.status || '',
    }));
  } catch (e) { err(res, e); }
});

app.get('/api/orders/:id', async (req, res) => {
  try { ok(res, await bybit.getOrderDetail(req.params.id)); }
  catch (e) { err(res, e); }
});

app.post('/api/orders/:id/pay', async (req, res) => {
  try { ok(res, await bybit.confirmPayment(req.params.id)); }
  catch (e) { err(res, e); }
});

app.post('/api/orders/:id/release', async (req, res) => {
  try { ok(res, await bybit.releaseAsset(req.params.id)); }
  catch (e) { err(res, e); }
});

app.post('/api/orders/:id/cancel', async (req, res) => {
  try { ok(res, await bybit.cancelOrder(req.params.id, req.body.cancelType || '1')); }
  catch (e) { err(res, e); }
});

app.post('/api/orders/:id/appeal', async (req, res) => {
  try { ok(res, await bybit.appealOrder(req.params.id, req.body.appealType, req.body.appealNote)); }
  catch (e) { err(res, e); }
});

// ── Chat ──
app.get('/api/orders/:id/messages', async (req, res) => {
  try { ok(res, await bybit.getChatMessages(req.params.id, Number(req.query.size) || 50)); }
  catch (e) { err(res, e); }
});

app.post('/api/orders/:id/messages', async (req, res) => {
  try { ok(res, await bybit.sendChatMessage(req.params.id, req.body.message, req.body.msgType || 'str')); }
  catch (e) { err(res, e); }
});

// ── Static: serve Mini App ────────────────────────────────────────────────────
// All non-API routes return index.html (SPA)
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  Server listening on port ${PORT}`);
  console.log(`📱  Mini App:  http://localhost:${PORT}/`);
  console.log(`🔌  API:       http://localhost:${PORT}/api/health`);
  console.log(`🌐  Testnet:   ${process.env.BYBIT_TESTNET === 'true'}`);
});

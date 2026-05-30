/**
 * api/index.jsuuyf
 * ⚠️  VERCEL DEPLOYMENT ONLY — single-user mode.
 *
 * Fixes applied:
 *  1. /api/balance: was calling getAccountBalance() with no coin param;
 *     now passes coin from query string (defaults to USDT)
 *  2. /api/orders: was passing status:'' to getOrders() which can cause
 *     Bybit to reject — now passes undefined when empty
 *  3. Singleton bybit client was created at module load time before dotenv runs;
 *     moved to lazy initialization inside handler so env vars are always loaded
 *  4. readBody() had no size limit — added 1MB cap to prevent memory DoS
 */

'use strict';

try { require('dotenv').config(); } catch (_) {}

const path        = require('path');
const BybitP2PApi = require(path.join(__dirname, '../lib/bybit-api'));

// FIX #3: Lazy singleton — created on first request so dotenv has run
let _bybit = null;
function getBybit() {
  if (!_bybit) {
    _bybit = new BybitP2PApi(
      process.env.BYBIT_API_KEY    || '',
      process.env.BYBIT_API_SECRET || '',
      process.env.BYBIT_TESTNET === 'true'
    );
  }
  return _bybit;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-telegram-init-data');
}

function ok(res, data)        { return res.status(200).json(data); }
function notFound(res, route) { return res.status(404).json({ error: `Unknown route: ${route}` }); }
function serverErr(res, e)    { return res.status(500).json({ error: e?.message || String(e) }); }

// FIX #4: 1MB body size limit
const MAX_BODY = 1024 * 1024;
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return resolve({}); }
      raw += c;
    });
    req.on('end',  () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function getApiPath(req) {
  const url   = new URL(req.url, 'https://placeholder');
  const clean = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  return '/' + clean;
}

function getQuery(req) {
  const url = new URL(req.url, 'https://placeholder');
  return Object.fromEntries(url.searchParams.entries());
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const method = req.method.toUpperCase();
  const route  = getApiPath(req);
  const query  = getQuery(req);
  const body   = ['POST','PUT','PATCH'].includes(method) ? await readBody(req) : {};

  if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
    return res.status(503).json({
      error: 'Bybit API credentials not configured. Set BYBIT_API_KEY and BYBIT_API_SECRET.',
    });
  }

  // FIX #3: use lazy getter
  const bybit = getBybit();

  try {
    // Health
    if (route === '/' || route === '/health') {
      return ok(res, { ok: true, ts: Date.now(), testnet: process.env.BYBIT_TESTNET === 'true' });
    }

    // Account
    // FIX #1: pass coin from query (default USDT)
    if (method === 'GET' && route === '/balance')         return ok(res, await bybit.getAccountBalance(query.coin || 'USDT'));
    if (method === 'GET' && route === '/profile')         return ok(res, await bybit.getP2PProfile());
    if (method === 'GET' && route === '/payment-methods') return ok(res, await bybit.getPaymentMethods());
    if (method === 'GET' && route === '/tokens')          return ok(res, await bybit.getSupportedTokens());
    if (method === 'GET' && route === '/currencies')      return ok(res, await bybit.getSupportedCurrencies());

    // Market
    if (method === 'GET' && route === '/market/ads') return ok(res, await bybit.getMarketAds(query));

    // Ads
    if (method === 'GET'  && route === '/ads') return ok(res, await bybit.getMyAds({ page: query.page || 1, size: query.size || 20, tokenId: query.tokenId, side: query.side }));
    if (method === 'POST' && route === '/ads') return ok(res, await bybit.createAd(body));

    // /ads/:id
    const adsIdMatch = route.match(/^\/ads\/([^/]+)$/);
    if (adsIdMatch) {
      const adId = adsIdMatch[1];
      if (method === 'GET')    return ok(res, await bybit.getAdDetail(adId));
      if (method === 'PUT')    return ok(res, await bybit.updateAd(adId, body));
      if (method === 'DELETE') return ok(res, await bybit.deleteAd(adId));
    }

    // /ads/:id/status
    const adsStatusMatch = route.match(/^\/ads\/([^/]+)\/status$/);
    if (adsStatusMatch && method === 'PATCH') return ok(res, await bybit.toggleAdStatus(adsStatusMatch[1], body.status));

    // Orders — /history before /:id
    if (method === 'GET' && route === '/orders/history') return ok(res, await bybit.getOrderHistory(Number(query.days) || 30));
    // FIX #2: don't pass status:'' — pass undefined when empty so Bybit returns all
    if (method === 'GET' && route === '/orders') return ok(res, await bybit.getOrders({
      page:   query.page   || 1,
      size:   query.size   || 20,
      status: query.status || undefined,
    }));

    // /orders/:id (exact)
    const orderIdMatch = route.match(/^\/orders\/([^/]+)$/);
    if (orderIdMatch && method === 'GET') return ok(res, await bybit.getOrderDetail(orderIdMatch[1]));

    // /orders/:id/:action
    const orderActionMatch = route.match(/^\/orders\/([^/]+)\/([^/]+)$/);
    if (orderActionMatch) {
      const [, orderId, action] = orderActionMatch;
      if (method === 'GET'  && action === 'messages') return ok(res, await bybit.getChatMessages(orderId, Number(query.size) || 50));
      if (method === 'POST' && action === 'messages') return ok(res, await bybit.sendChatMessage(orderId, body.message, body.msgType || 'str'));
      if (method === 'POST' && action === 'pay')      return ok(res, await bybit.confirmPayment(orderId));
      if (method === 'POST' && action === 'release')  return ok(res, await bybit.releaseAsset(orderId));
      if (method === 'POST' && action === 'cancel')   return ok(res, await bybit.cancelOrder(orderId, body.cancelType || '1'));
      if (method === 'POST' && action === 'appeal')   return ok(res, await bybit.appealOrder(orderId, body.appealType, body.appealNote));
    }

    return notFound(res, `${method} ${route}`);

  } catch (e) {
    console.error(`[api] ${method} ${route}`, e);
    return serverErr(res, e);
  }
};

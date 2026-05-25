/**
 * api/index.js
 * Vercel Serverless Function — handles every /api/* request
 *
 * Route map:
 *   GET  /api/health
 *   GET  /api/balance
 *   GET  /api/profile
 *   GET  /api/payment-methods
 *   GET  /api/tokens
 *   GET  /api/currencies
 *
 *   GET    /api/ads
 *   POST   /api/ads
 *   GET    /api/ads/:id
 *   PUT    /api/ads/:id
 *   PATCH  /api/ads/:id/status
 *   DELETE /api/ads/:id
 *
 *   GET  /api/orders
 *   GET  /api/orders/history
 *   GET  /api/orders/:id
 *   POST /api/orders/:id/pay
 *   POST /api/orders/:id/release
 *   POST /api/orders/:id/cancel
 *   POST /api/orders/:id/appeal
 *
 *   GET  /api/orders/:id/messages
 *   POST /api/orders/:id/messages
 *
 *   GET  /api/market/ads
 */

'use strict';

// Vercel injects env vars; dotenv is a no-op in prod but useful locally
try { require('dotenv').config(); } catch (_) {}

const path  = require('path');
const BybitP2PApi = require(path.join(__dirname, '../lib/bybit-api'));

// ── Singleton API client (reused across warm invocations) ─────────────────────
const bybit = new BybitP2PApi(
  process.env.BYBIT_API_KEY    || '',
  process.env.BYBIT_API_SECRET || '',
  process.env.BYBIT_TESTNET === 'true'
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-telegram-init-data');
}

function ok(res, data)        { return res.status(200).json(data); }
function notFound(res, route) { return res.status(404).json({ error: `Unknown route: ${route}` }); }
function serverErr(res, e)    { return res.status(500).json({ error: e?.message || String(e) }); }

/** Read the raw request body as parsed JSON */
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Extract the path segment after /api, normalised.
 * Vercel passes req.url as the full path, e.g. /api/orders/ORD123/messages
 */
function getApiPath(req) {
  const url   = new URL(req.url, `https://placeholder`);
  const clean = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  return '/' + clean;   // always starts with /
}

function getQuery(req) {
  const url = new URL(req.url, `https://placeholder`);
  return Object.fromEntries(url.searchParams.entries());
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  setCors(res);

  // Pre-flight
  if (req.method === 'OPTIONS') return res.status(204).end();

  const method = req.method.toUpperCase();
  const route  = getApiPath(req);    // e.g. /orders/ORD123/messages
  const query  = getQuery(req);
  const body   = ['POST','PUT','PATCH'].includes(method) ? await readBody(req) : {};

  // Validate API keys are configured
  if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
    return res.status(503).json({ error: 'Bybit API credentials not configured. Set BYBIT_API_KEY and BYBIT_API_SECRET environment variables.' });
  }

  try {

    // ── Health ────────────────────────────────────────────────────────────────
    if (route === '/' || route === '/health') {
      return ok(res, { ok: true, ts: Date.now(), testnet: process.env.BYBIT_TESTNET === 'true' });
    }

    // ── Account ───────────────────────────────────────────────────────────────
    if (method === 'GET' && route === '/balance') {
      return ok(res, await bybit.getAccountBalance());
    }
    if (method === 'GET' && route === '/profile') {
      return ok(res, await bybit.getP2PProfile());
    }
    if (method === 'GET' && route === '/payment-methods') {
      return ok(res, await bybit.getPaymentMethods());
    }
    if (method === 'GET' && route === '/tokens') {
      return ok(res, await bybit.getSupportedTokens());
    }
    if (method === 'GET' && route === '/currencies') {
      return ok(res, await bybit.getSupportedCurrencies());
    }

    // ── Market ────────────────────────────────────────────────────────────────
    if (method === 'GET' && route === '/market/ads') {
      return ok(res, await bybit.getMarketAds(query));
    }

    // ── Ads ───────────────────────────────────────────────────────────────────
    if (method === 'GET' && route === '/ads') {
      return ok(res, await bybit.getMyAds({
        page:    query.page    || 1,
        size:    query.size    || 20,
        tokenId: query.tokenId,
        side:    query.side,
      }));
    }
    if (method === 'POST' && route === '/ads') {
      return ok(res, await bybit.createAd(body));
    }

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
    if (adsStatusMatch && method === 'PATCH') {
      return ok(res, await bybit.toggleAdStatus(adsStatusMatch[1], body.status));
    }

    // ── Orders ────────────────────────────────────────────────────────────────
    if (method === 'GET' && route === '/orders/history') {
      return ok(res, await bybit.getOrderHistory(Number(query.days) || 30));
    }
    if (method === 'GET' && route === '/orders') {
      return ok(res, await bybit.getOrders({
        page:   query.page   || 1,
        size:   query.size   || 20,
        status: query.status || '',
      }));
    }

    // /orders/:id  (exact, no sub-path)
    const orderIdMatch = route.match(/^\/orders\/([^/]+)$/);
    if (orderIdMatch && method === 'GET') {
      return ok(res, await bybit.getOrderDetail(orderIdMatch[1]));
    }

    // /orders/:id/:action
    const orderActionMatch = route.match(/^\/orders\/([^/]+)\/([^/]+)$/);
    if (orderActionMatch) {
      const [, orderId, action] = orderActionMatch;

      if (method === 'GET'  && action === 'messages') {
        return ok(res, await bybit.getChatMessages(orderId, Number(query.size) || 50));
      }
      if (method === 'POST' && action === 'messages') {
        return ok(res, await bybit.sendChatMessage(orderId, body.message, body.msgType || 'str'));
      }
      if (method === 'POST' && action === 'pay') {
        return ok(res, await bybit.confirmPayment(orderId));
      }
      if (method === 'POST' && action === 'release') {
        return ok(res, await bybit.releaseAsset(orderId));
      }
      if (method === 'POST' && action === 'cancel') {
        return ok(res, await bybit.cancelOrder(orderId, body.cancelType || '1'));
      }
      if (method === 'POST' && action === 'appeal') {
        return ok(res, await bybit.appealOrder(orderId, body.appealType, body.appealNote));
      }
    }

    // ── Not found ─────────────────────────────────────────────────────────────
    return notFound(res, `${method} ${route}`);

  } catch (e) {
    console.error(`[api] ${method} ${route}`, e);
    return serverErr(res, e);
  }
};

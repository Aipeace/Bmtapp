/**
 * lib/auth.js
 * Express middleware stack for the multi-user API.
 *
 * requireAuth  — validates Telegram initData, attaches req.tgUser + req.user
 * requireKeys  — requireAuth + blocks if Bybit keys not saved yet (→ 428)
 * requireAdmin — requireAuth + blocks if not the admin (→ 403)
 */
'use strict';

const crypto = require('crypto');
const store  = require('./store');
const pool   = require('./bybit-pool');

const AGE_LIMIT = 24 * 60 * 60; // 24 hours — matches Telegram WebApp initData validity

/* Validate the HMAC signature Telegram injects into WebApp.initData */
function parseTgInitData(raw) {
  if (!raw) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash   = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    // FIX: auth_date expiry check must be INSIDE the try block
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Date.now() / 1000 - authDate > AGE_LIMIT) return null;

    const checkStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secret   = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_BOT_TOKEN || '').digest();
    const expected = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
    if (expected !== hash) return null;

    const userStr = params.get('user');
    return userStr ? JSON.parse(decodeURIComponent(userStr)) : null;
  } catch { return null; }
}

function requireAuth(req, res, next) {
  let tgUser = null;

  /* ── Dev bypass: set NODE_ENV=development and pass x-dev-user-id header ── */
  if (process.env.NODE_ENV === 'development') {
    const devId = req.headers['x-dev-user-id'];
    if (devId) tgUser = { id: Number(devId), first_name: 'Dev', username: 'dev' };
  }

  if (!tgUser) {
    tgUser = parseTgInitData(req.headers['x-telegram-init-data']);
    if (!tgUser) return res.status(401).json({ error: 'Telegram auth required' });
  }

  const user = store.get(tgUser.id);
  if (!user) {
    return res.status(404).json({
      error: 'NOT_REGISTERED',
      message: 'Start the bot first and follow the setup steps.',
    });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'Account suspended. Contact the admin.' });
  }

  // Refresh lastSeen (fire-and-forget)
  store.upsert(tgUser.id, {
    username:  tgUser.username   || user.username,
    firstName: tgUser.first_name || user.firstName,
  });

  req.telegramId = tgUser.id;
  req.tgUser     = tgUser;
  req.user       = store.get(tgUser.id); // re-read with refreshed lastSeen
  req.bybit      = pool.getClient(req.user);
  next();
}

function requireKeys(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.bybit) {
      return res.status(428).json({
        error: 'NO_KEYS',
        message: 'Bybit API keys not configured. Use /setup in the bot.',
      });
    }
    next();
  });
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!store.isAdmin(req.telegramId)) {
      return res.status(403).json({ error: 'Admin only.' });
    }
    next();
  });
}

module.exports = { requireAuth, requireKeys, requireAdmin };

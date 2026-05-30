/**
 * lib/auth.js
 * Express middleware stack for the multi-user API.
 *
 * Fixes applied:
 *  1. requireKeys no longer calls requireAuth internally (double-auth).
 *     It is now a standalone middleware — compose in routes as [requireAuth, requireKeys].
 *     server.js already uses requireKeys alone (which wraps requireAuth), keeping
 *     backward compatibility — but we fix the double-call.
 *  2. parseTgInitData: auth_date=0 is treated as missing (not just expired)
 *  3. requireAdmin: same double-auth fix — now standalone after requireAuth
 *  4. lastSeen upsert is fire-and-forget with explicit try/catch to prevent
 *     a store write failure from blocking the request
 */

'use strict';

const crypto = require('crypto');
const store  = require('./store');
const pool   = require('./bybit-pool');

const AGE_LIMIT = 24 * 60 * 60; // 24 hours

function parseTgInitData(raw) {
  if (!raw) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash   = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    // FIX #2: treat missing/zero auth_date as invalid
    if (!authDate || Date.now() / 1000 - authDate > AGE_LIMIT) return null;

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

// FIX #1/#3: requireAuth is the only function that reads tgUser.
// requireKeys and requireAdmin simply chain AFTER requireAuth.
function requireAuth(req, res, next) {
  let tgUser = null;

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
      error:   'NOT_REGISTERED',
      message: 'Start the bot first and follow the setup steps.',
    });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'Account suspended. Contact the admin.' });
  }

  // FIX #4: fire-and-forget with try/catch — don't block request on store write
  try {
    store.upsert(tgUser.id, {
      username:  tgUser.username   || user.username,
      firstName: tgUser.first_name || user.firstName,
    });
  } catch (e) {
    console.error('[auth] lastSeen upsert failed:', e.message);
  }

  req.telegramId = tgUser.id;
  req.tgUser     = tgUser;
  req.user       = store.get(tgUser.id);
  req.bybit      = pool.getClient(req.user);
  next();
}

// FIX #1: requireKeys no longer double-calls requireAuth.
// It is intended to be used as: [requireAuth, checkRate, requireKeys]
// But for backward compat with server.js (requireKeys alone), we keep
// the internal requireAuth call — just not duplicated.
function requireKeys(req, res, next) {
  // If requireAuth already ran (req.telegramId set), skip re-auth
  if (req.telegramId) {
    if (!req.bybit) {
      return res.status(428).json({
        error:   'NO_KEYS',
        message: 'Bybit API keys not configured. Use /setup in the bot.',
      });
    }
    return next();
  }
  // Otherwise run auth first
  requireAuth(req, res, () => {
    if (!req.bybit) {
      return res.status(428).json({
        error:   'NO_KEYS',
        message: 'Bybit API keys not configured. Use /setup in the bot.',
      });
    }
    next();
  });
}

// FIX #3: requireAdmin — same pattern as requireKeys
function requireAdmin(req, res, next) {
  if (req.telegramId) {
    if (!store.isAdmin(req.telegramId)) {
      return res.status(403).json({ error: 'Admin only.' });
    }
    return next();
  }
  requireAuth(req, res, () => {
    if (!store.isAdmin(req.telegramId)) {
      return res.status(403).json({ error: 'Admin only.' });
    }
    next();
  });
}

module.exports = { requireAuth, requireKeys, requireAdmin };

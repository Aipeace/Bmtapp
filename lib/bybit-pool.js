/**
 * lib/bybit-pool.js
 * Returns a cached BybitP2PApi instance per user.
 * Cache is invalidated when API keys change.
 */
'use strict';

const BybitP2PApi = require('./bybit-api');

const pool = new Map(); // `${telegramId}:${apiKey}` → BybitP2PApi

function getClient(user) {
  if (!user?.apiKey || !user?.apiSecret) return null;
  const key = `${user.telegramId}:${user.apiKey}`;
  if (!pool.has(key)) {
    pool.set(key, new BybitP2PApi(user.apiKey, user.apiSecret, user.testnet === true));
  }
  return pool.get(key);
}

function evict(telegramId) {
  for (const k of pool.keys()) {
    if (k.startsWith(`${telegramId}:`)) pool.delete(k);
  }
}

module.exports = { getClient, evict };

/**
 * lib/bybit-pool.js
 * Returns a cached BybitP2PApi instance per user.
 * Cache is invalidated when API keys change (key includes apiKey + testnet flag).
 * Pool is capped at 500 entries to prevent unbounded memory growth when users
 * rotate keys frequently.
 */
'use strict';

const BybitP2PApi = require('./bybit-api');

const POOL_MAX = 500;
const pool     = new Map(); // `${telegramId}:${apiKey}:${testnet}` → BybitP2PApi

function getClient(user) {
  if (!user?.apiKey || !user?.apiSecret) return null;
  const key = `${user.telegramId}:${user.apiKey}:${user.testnet === true}`;
  if (!pool.has(key)) {
    // Evict the oldest entry when the pool is full
    if (pool.size >= POOL_MAX) {
      const oldest = pool.keys().next().value;
      pool.delete(oldest);
    }
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

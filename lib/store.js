/**
 * lib/store.js
 * Persistent file-based user store — data/users.json
 * No database required. Works on Render free tier with ephemeral disk.
 *
 * User shape:
 * {
 *   telegramId   : number,
 *   username     : string,
 *   firstName    : string,
 *   apiKey       : string,   // Bybit API key (user-supplied)
 *   apiSecret    : string,   // Bybit API secret (user-supplied)
 *   testnet      : boolean,
 *   active       : boolean,  // admin can suspend
 *   isAdmin      : boolean,
 *   registeredAt : string,   // ISO timestamp
 *   lastSeen     : string,
 * }
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '../data');
const STORE_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '{}', 'utf8');

function read() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return {}; }
}
function write(data) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const store = {
  get(telegramId) {
    return read()[String(telegramId)] ?? null;
  },

  getAll() {
    return Object.values(read());
  },

  upsert(telegramId, fields) {
    const all     = read();
    const key     = String(telegramId);
    const adminId = Number(process.env.ADMIN_TELEGRAM_ID || 0);
    all[key] = {
      ...(all[key] || {}),
      telegramId:  Number(telegramId),
      isAdmin:     Number(telegramId) === adminId,
      active:      all[key]?.active ?? true,
      registeredAt: all[key]?.registeredAt ?? new Date().toISOString(),
      ...fields,
      lastSeen: new Date().toISOString(),
    };
    write(all);
    return all[key];
  },

  remove(telegramId) {
    const all = read();
    delete all[String(telegramId)];
    write(all);
  },

  setActive(telegramId, active) {
    return this.upsert(telegramId, { active: Boolean(active) });
  },

  hasKeys(telegramId) {
    const u = this.get(telegramId);
    return !!(u?.apiKey && u?.apiSecret);
  },

  isAdmin(telegramId) {
    return Number(telegramId) === Number(process.env.ADMIN_TELEGRAM_ID || 0);
  },

  count() {
    return Object.keys(read()).length;
  },
};

module.exports = store;

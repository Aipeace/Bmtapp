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
 *   apiSecret    : string,   // Bybit API secret (AES-256-CBC encrypted)
 *   testnet      : boolean,
 *   active       : boolean,  // admin can suspend
 *   isAdmin      : boolean,
 *   registeredAt : string,   // ISO timestamp
 *   lastSeen     : string,
 * }
 */
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR   = path.join(__dirname, '../data');
const STORE_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '{}', 'utf8');

// ── Encryption helpers ────────────────────────────────────────────────────────
const ENC_KEY = (process.env.APP_SECRET || 'change_me_32_chars_exactly!!!!!!').slice(0, 32);
const IV_LEN  = 16;

function encrypt(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(IV_LEN);
  const c  = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENC_KEY), iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(text), c.final()]).toString('hex');
}

function decrypt(text) {
  if (!text || !text.includes(':')) return text;
  const [ivHex, encHex] = text.split(':');
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENC_KEY), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString();
}

// ── Disk helpers ──────────────────────────────────────────────────────────────
function read() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return {}; }
}
function write(data) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Store ─────────────────────────────────────────────────────────────────────
const store = {
  get(telegramId) {
    const raw = read()[String(telegramId)];
    if (!raw) return null;
    // Decrypt apiSecret on the way out
    if (raw.apiSecret) {
      try { raw.apiSecret = decrypt(raw.apiSecret); } catch { /* already plain */ }
    }
    return raw;
  },

  getAll() {
    return Object.values(read()).map(u => {
      if (u.apiSecret) {
        try { u.apiSecret = decrypt(u.apiSecret); } catch { /* already plain */ }
      }
      return u;
    });
  },

  upsert(telegramId, fields) {
    const all     = read();
    const key     = String(telegramId);
    const adminId = Number(process.env.ADMIN_TELEGRAM_ID || 0);

    // Encrypt apiSecret before writing to disk
    if (fields.apiSecret) {
      fields = { ...fields, apiSecret: encrypt(fields.apiSecret) };
    }

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

    // Return decrypted version to caller
    return this.get(telegramId);
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

/**
 * lib/store.js
 * Persistent file-based user store — data/users.json
 *
 * Fixes applied:
 *  1. encrypt() now validates key is exactly 32 bytes — throws early with clear message
 *  2. decrypt() now handles corrupted/plain-text values gracefully without throwing
 *  3. getAll() and get() now return decrypted copies — never mutate the raw disk object
 *  4. write() now uses atomic write (temp file + rename) to prevent data corruption
 *     if the process is killed mid-write
 *  5. upsert() now strips undefined fields instead of writing them as null
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR   = path.join(__dirname, '../data');
const STORE_FILE = path.join(DATA_DIR, 'users.json');
const STORE_TMP  = STORE_FILE + '.tmp';

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '{}', 'utf8');

// ── Encryption helpers ────────────────────────────────────────────────────

function getEncKey() {
  const raw = (process.env.APP_SECRET || 'change_me_32_chars_exactly!!!!!!').slice(0, 32);
  // FIX #1: pad short keys to exactly 32 bytes instead of silently truncating
  return raw.padEnd(32, '0');
}

const IV_LEN = 16;

function encrypt(text) {
  if (!text) return text;
  const key = getEncKey();
  // FIX #1: validate key length upfront
  if (Buffer.byteLength(key) !== 32) throw new Error('APP_SECRET must produce a 32-byte key');
  const iv = crypto.randomBytes(IV_LEN);
  const c  = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(text), c.final()]).toString('hex');
}

function decrypt(text) {
  // FIX #2: handle plain text, empty, or corrupted values without throwing
  if (!text) return text;
  if (!text.includes(':')) return text; // not encrypted — return as-is
  try {
    const [ivHex, encHex] = text.split(':');
    const key = getEncKey();
    const d   = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString();
  } catch {
    // Decryption failed (wrong key, corrupted data) — return raw so caller can detect
    return text;
  }
}

// ── Disk helpers ──────────────────────────────────────────────────────────

function read() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return {}; }
}

// FIX #4: atomic write — write to temp file then rename to prevent corruption
function write(data) {
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(STORE_TMP, json, 'utf8');
  fs.renameSync(STORE_TMP, STORE_FILE);
}

// FIX #3: return a decrypted COPY so we never mutate the raw disk object
function decryptUser(raw) {
  if (!raw) return null;
  const copy = { ...raw };
  if (copy.apiSecret) {
    copy.apiSecret = decrypt(copy.apiSecret);
  }
  return copy;
}

// ── Store ─────────────────────────────────────────────────────────────────

const store = {
  get(telegramId) {
    const raw = read()[String(telegramId)];
    return decryptUser(raw);
  },

  getAll() {
    return Object.values(read()).map(decryptUser);
  },

  upsert(telegramId, fields) {
    const all     = read();
    const key     = String(telegramId);
    const adminId = Number(process.env.ADMIN_TELEGRAM_ID || 0);

    // Encrypt apiSecret before writing to disk
    if (fields.apiSecret) {
      fields = { ...fields, apiSecret: encrypt(fields.apiSecret) };
    }

    // FIX #5: strip undefined fields to avoid writing null into the store
    const cleanFields = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );

    all[key] = {
      ...(all[key] || {}),
      telegramId:   Number(telegramId),
      isAdmin:      Number(telegramId) === adminId,
      active:       all[key]?.active ?? true,
      watchOrders:  all[key]?.watchOrders ?? false,
      priceAlerts:  all[key]?.priceAlerts ?? [],
      registeredAt: all[key]?.registeredAt ?? new Date().toISOString(),
      ...cleanFields,
      lastSeen: new Date().toISOString(),
    };
    write(all);

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

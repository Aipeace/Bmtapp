/**
 * lib/store.js
 * Persistent file-based user store — data/users.json
 *
 * Fixes applied:
 *  1. encrypt() uses Buffer.alloc(32) for the key so it works regardless of
 *     whether APP_SECRET is ASCII or multi-byte; avoids byteLength mismatch.
 *  2. decrypt() handles corrupted/plain-text values gracefully without throwing.
 *  3. getAll() and get() return decrypted copies — never mutate the raw disk object.
 *  4. write() uses a per-write unique temp filename to prevent race corruption
 *     when two writes happen concurrently (e.g. bot + server both writing).
 *  5. upsert() strips undefined fields instead of writing them as null.
 *  6. In-memory cache with dirty-flag: disk is only read on startup and after
 *     an external write (detected via mtime). This drastically cuts I/O on Termux
 *     where repeated small reads are slow on eMMC/SD storage.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_DIR   = path.join(__dirname, '../data');
const STORE_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '{}', 'utf8');

// ── Encryption helpers ────────────────────────────────────────────────────

// FIX #1: Always produce exactly 32 bytes regardless of character encoding.
function getEncKey() {
  const raw = process.env.APP_SECRET || 'change_me_32_chars_exactly!!!!!!';
  const buf = Buffer.alloc(32, 0);
  Buffer.from(raw, 'utf8').copy(buf, 0, 0, 32);
  return buf;
}

const IV_LEN = 16;

function encrypt(text) {
  if (!text) return text;
  const key = getEncKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const c   = crypto.createCipheriv('aes-256-cbc', key, iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(text), c.final()]).toString('hex');
}

function decrypt(text) {
  // FIX #2: handle plain text, empty, or corrupted values without throwing
  if (!text) return text;
  if (!text.includes(':')) return text; // not encrypted — return as-is
  try {
    const [ivHex, encHex] = text.split(':');
    const key = getEncKey();
    const d   = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString();
  } catch {
    return text; // wrong key or corrupted data — return raw
  }
}

// ── In-memory cache (FIX #6) ──────────────────────────────────────────────

let _cache     = null;
let _cacheMtime = 0;

function _getMtime() {
  try { return fs.statSync(STORE_FILE).mtimeMs; } catch { return 0; }
}

function read() {
  const mtime = _getMtime();
  if (_cache && mtime <= _cacheMtime) return _cache;
  try {
    _cache      = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    _cacheMtime = mtime;
    return _cache;
  } catch {
    _cache = {};
    return _cache;
  }
}

// FIX #4: unique temp file per write prevents concurrent-write corruption
function write(data) {
  const json    = JSON.stringify(data, null, 2);
  const tmpFile = STORE_FILE + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmpFile, json, 'utf8');
  fs.renameSync(tmpFile, STORE_FILE);
  // Update cache immediately so callers in the same process see the new data
  _cache      = data;
  _cacheMtime = _getMtime();
}

// FIX #3: return a decrypted COPY so we never mutate the raw disk object
function decryptUser(raw) {
  if (!raw) return null;
  const copy = { ...raw };
  if (copy.apiSecret) copy.apiSecret = decrypt(copy.apiSecret);
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

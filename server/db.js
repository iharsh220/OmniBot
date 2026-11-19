// Embedded SQLite (node:sqlite — built into Node 22.5+, no external database needed).
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'omnichat.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  name        TEXT,
  avatar      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,            -- 'youtube' | 'kick'
  provider_user_id TEXT NOT NULL,            -- YouTube channel id / Kick user id
  channel_id       TEXT,
  channel_name     TEXT,
  channel_slug     TEXT,
  avatar           TEXT,
  access_token     TEXT,                     -- AES-256-GCM encrypted
  refresh_token    TEXT,                     -- AES-256-GCM encrypted
  expires_at       INTEGER,
  scope            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS widgets (
  id          TEXT PRIMARY KEY,              -- random public id used in /w/<id>
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                 -- 'chat' | 'stats'
  name        TEXT NOT NULL,
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id       INTEGER PRIMARY KEY,
  user_id  INTEGER,
  ts       INTEGER NOT NULL,
  level    TEXT NOT NULL,                    -- info | warn | error
  source   TEXT NOT NULL,                    -- youtube | kick | auth | system
  message  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_user_ts ON logs (user_id, ts);

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT NOT NULL,
  user_id   INTEGER NOT NULL,
  platform  TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  author    TEXT NOT NULL,
  text      TEXT,
  data      TEXT NOT NULL,                   -- full normalised message JSON
  deleted   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS messages_user_ts ON messages (user_id, ts);
`);

// ── Migrations (additive, safe to re-run) ─────────────────────────────
for (const sql of [
  'ALTER TABLE accounts ADD COLUMN kick_chatroom_id INTEGER',
  'ALTER TABLE accounts ADD COLUMN kick_channel_id INTEGER',   // Kick internal channel id (not the user id), for follower events
  'ALTER TABLE accounts ADD COLUMN kick_followers INTEGER',
  'ALTER TABLE users ADD COLUMN history_days INTEGER NOT NULL DEFAULT 7',  // chat history retention chosen by the user (0 = off)    // last known follower total
]) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

// ── Token encryption ───────────────────────────────────────────────────
const KEY = crypto.createHash('sha256').update(config.appSecret).digest();
export function encrypt(text) {
  if (text === null || text === undefined) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── Housekeeping ───────────────────────────────────────────────────────
const DAY = 86_400_000;
export function prune() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM logs WHERE ts < ?').run(now - 14 * DAY);
  db.prepare('DELETE FROM messages WHERE ts < ?').run(now - 30 * DAY);
  // Per-user retention (0 = keep nothing).
  db.prepare('DELETE FROM messages WHERE ts < ? - COALESCE((SELECT history_days FROM users WHERE users.id = messages.user_id), 7) * ?').run(now, DAY);
  db.prepare('DELETE FROM messages WHERE user_id NOT IN (SELECT id FROM users)').run();
}

import { EventEmitter } from 'node:events';
import { db } from './db.js';

export const logEvents = new EventEmitter();
const insert = db.prepare('INSERT INTO logs (user_id, ts, level, source, message) VALUES (?, ?, ?, ?, ?)');

export function log(userId, level, source, message) {
  const row = { user_id: userId ?? null, ts: Date.now(), level, source, message: String(message).slice(0, 2000) };
  const tag = `[${source}${userId ? ` u${userId}` : ''}]`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(tag, row.message);
  try {
    const r = insert.run(row.user_id, row.ts, row.level, row.source, row.message);
    row.id = Number(r.lastInsertRowid);
  } catch (e) {
    console.error('[logger] failed to write log', e.message);
  }
  logEvents.emit('log', row);
  return row;
}

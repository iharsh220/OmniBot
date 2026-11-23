// Per-user ring buffers: live events (chat/delete), system logs and chat history.
import * as db from './store.js';

const DAY = 86_400_000;
const EVENTS_MAX = 150;
const LOGS_MAX = 300;
const HISTORY_MAX = 2000;

/** Append system log lines for a user (one write for the batch). */
export async function addLogs(uid, entries) {
  if (!uid || !entries.length) return;
  for (const e of entries) (e.level === 'error' ? console.error : console.log)(`[${e.source} ${uid}] ${e.message}`);
  const now = Date.now();
  await db.update(`logs/${uid}`, (L) => {
    for (const e of entries) {
      L.seq += 1;
      L.items.push({ id: L.seq, ts: e.ts || now, level: e.level, source: e.source, message: String(e.message).slice(0, 2000) });
    }
    L.items = L.items.filter((x) => x.ts > now - 14 * DAY).slice(-LOGS_MAX);
    return L;
  }, { seq: 0, items: [] });
}
export const log = (uid, level, source, message) => addLogs(uid, [{ level, source, message }]);

/** Append chat messages / deletions to the live buffer (+ chat history when enabled). */
export async function addEvents(uid, { chats = [], deletes = [], historyDays = 7 } = {}) {
  if (!chats.length && !deletes.length) return;
  await db.update(`events/${uid}`, (E) => {
    const have = new Set(E.items.filter((x) => x.t === 'chat').map((x) => x.msg.id));
    let changed = false;
    for (const msg of chats) {
      if (have.has(msg.id)) continue;
      have.add(msg.id);
      E.seq += 1;
      E.items.push({ seq: E.seq, t: 'chat', msg });
      changed = true;
    }
    for (const id of deletes) { E.seq += 1; E.items.push({ seq: E.seq, t: 'delete', id }); changed = true; }
    if (!changed) return undefined;
    E.items = E.items.slice(-EVENTS_MAX);
    return E;
  }, { seq: 0, items: [] });

  if (historyDays > 0) {
    const now = Date.now();
    await db.update(`history/${uid}`, (H) => {
      const have = new Set(H.items.map((x) => x.id));
      for (const m of chats) {
        if (have.has(m.id)) continue;
        const text = (m.parts || []).map((p) => (p.type === 'emote' ? `:${p.name}:` : p.text)).join('') || m.eventText || '';
        H.items.push({ id: m.id, platform: m.platform, ts: m.ts, kind: m.kind, alert: m.alert || null, amount: m.amount || null, author: m.author?.name || '', text, deleted: 0 });
      }
      for (const id of deletes) { const x = H.items.find((i) => i.id === id); if (x) x.deleted = 1; }
      H.items = H.items.filter((x) => x.ts > now - historyDays * DAY).slice(-HISTORY_MAX);
      return H;
    }, { items: [] });
  }
}

/** Put one item in the live stream only (no chat history), e.g. a highlighted message. */
export async function pushEvent(uid, msg) {
  await db.update(`events/${uid}`, (E) => {
    E.seq += 1;
    E.items.push({ seq: E.seq, t: 'chat', msg });
    E.items = E.items.slice(-EVENTS_MAX);
    return E;
  }, { seq: 0, items: [] });
}

/** Events after `cursor`. First poll (no cursor) → recent chat as history. */
export async function readEvents(uid, cursor) {
  const E = (await db.get(`events/${uid}`)) || { seq: 0, items: [] };
  const history = () => E.items.filter((x) => x.t === 'chat').slice(-40).map((x) => x.msg);
  if (cursor === undefined || Number.isNaN(cursor) || cursor > E.seq) return { history: history(), cursor: E.seq };
  return { events: E.items.filter((x) => x.seq > cursor), cursor: E.seq };
}

export async function readLogs(uid, { cursor, level, q, limit = 300 } = {}) {
  const L = (await db.get(`logs/${uid}`)) || { seq: 0, items: [] };
  let items = L.items;
  if (cursor !== undefined && !Number.isNaN(cursor)) items = items.filter((x) => x.id > cursor);
  if (['info', 'warn', 'error'].includes(level)) items = items.filter((x) => x.level === level);
  if (q) { const s = q.toLowerCase(); items = items.filter((x) => `${x.message} ${x.source}`.toLowerCase().includes(s)); }
  return { rows: items.slice(-limit).reverse(), cursor: L.seq };
}

export async function readHistory(uid, { q, platform, limit = 500 } = {}) {
  const H = (await db.get(`history/${uid}`)) || { items: [] };
  let items = H.items;
  if (platform === 'youtube' || platform === 'kick') items = items.filter((x) => x.platform === platform);
  if (q) { const s = q.toLowerCase(); items = items.filter((x) => `${x.author} ${x.text}`.toLowerCase().includes(s)); }
  const since = Date.now() - DAY;
  const last24h = ['youtube', 'kick'].map((p) => ({ platform: p, n: H.items.filter((x) => x.platform === p && x.ts > since).length }));
  return { rows: items.slice(-limit).reverse(), last24h };
}

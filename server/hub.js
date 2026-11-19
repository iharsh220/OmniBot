// One UserHub per streamer: live state, recent chat, SSE clients and platform watchers.
import { config } from './config.js';
import { db } from './db.js';
import { log, logEvents } from './logger.js';
import { YouTubeWatcher } from './providers/youtube.js';
import { KickWatcher } from './providers/kick.js';

const WATCHERS = { youtube: YouTubeWatcher, kick: KickWatcher };
const HISTORY_MAX = 100;
const insertMsg = db.prepare('INSERT OR IGNORE INTO messages (id, user_id, platform, ts, kind, author, text, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const markDeleted = db.prepare('UPDATE messages SET deleted = 1 WHERE user_id = ? AND id = ?');

const blankPlatform = () => ({ connected: false, live: false, viewers: null, subscribers: null, followers: null, title: null, url: null, channelName: null, avatar: null, chatConnected: false, chatMode: null, error: null });

class UserHub {
  constructor(userId) {
    this.userId = userId;
    this.state = { youtube: blankPlatform(), kick: blankPlatform(), updatedAt: Date.now() };
    this.history = [];
    this.seen = new Set();
    this.clients = new Set(); // { res, kind: 'dashboard' | 'widget', widgetId }
    this.watchers = {};
    this.stopTimer = null;
    this.stateTimer = null;
    this.syncAccounts();
  }

  send(c, event, data) {
    // Widget URLs are public: never leak internal error text to them.
    if (c.kind === 'widget' && event === 'state') {
      data = { ...data, youtube: { ...data.youtube, error: null }, kick: { ...data.kick, error: null } };
    }
    c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  broadcast(event, data, filter = () => true) {
    for (const c of this.clients) if (filter(c)) this.send(c, event, data);
  }

  addClient(res, info) {
    const c = { res, ...info };
    this.clients.add(c);
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.send(c, 'state', this.state);
    this.send(c, 'history', this.history);
    res.on('close', () => {
      this.clients.delete(c);
      if (!this.clients.size) this.stopTimer = setTimeout(() => this.stopAll('no viewers'), config.idleStopMs);
    });
    this.ensureRunning();
  }

  /** Pull connected accounts from the DB into state. */
  syncAccounts() {
    const rows = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(this.userId);
    for (const p of Object.keys(WATCHERS)) {
      const acc = rows.find((r) => r.provider === p);
      if (!acc) {
        this.watchers[p]?.stop();
        delete this.watchers[p];
        this.state[p] = blankPlatform();
      } else {
        Object.assign(this.state[p], { connected: true, channelName: acc.channel_name, avatar: acc.avatar });
        if (p === 'kick' && acc.kick_followers != null && this.state.kick.followers == null) this.state.kick.followers = Number(acc.kick_followers);
      }
    }
    this.pushState();
    return rows;
  }

  ensureRunning() {
    const rows = this.syncAccounts();
    for (const acc of rows) {
      const W = WATCHERS[acc.provider];
      const cur = this.watchers[acc.provider];
      if (cur && cur.account.id === acc.id && !cur.stopped) continue;
      cur?.stop();
      this.watchers[acc.provider] = new W(this, acc);
      this.watchers[acc.provider].start();
    }
  }

  restart() {
    for (const w of Object.values(this.watchers)) w.stop();
    this.watchers = {};
    if (this.clients.size) this.ensureRunning();
    else this.syncAccounts();
  }

  stopAll(reason) {
    if (!Object.keys(this.watchers).length) return;
    for (const w of Object.values(this.watchers)) w.stop();
    this.watchers = {};
    for (const p of Object.keys(WATCHERS)) Object.assign(this.state[p], { chatConnected: false });
    log(this.userId, 'info', 'system', `Watchers paused (${reason})`);
  }

  // ── events from watchers ──
  log(level, source, message) {
    return log(this.userId, level, source, message);
  }
  update(platform, patch) {
    Object.assign(this.state[platform], patch);
    this.pushState();
  }
  pushState() {
    this.state.updatedAt = Date.now();
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.broadcast('state', this.state);
    }, 250);
  }
  chat(msg) {
    if (!msg?.id || this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value);
    this.history.push(msg);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    try {
      const text = (msg.parts || []).map((p) => (p.type === 'emote' ? `:${p.name}:` : p.text)).join('') || msg.eventText || '';
      insertMsg.run(msg.id, this.userId, msg.platform, msg.ts, msg.kind, msg.author?.name || '', text, JSON.stringify(msg));
    } catch { /* ignore */ }
    this.broadcast('chat', msg);
  }
  remove(id) {
    if (!id) return;
    const i = this.history.findIndex((m) => m.id === id);
    if (i >= 0) this.history.splice(i, 1);
    try { markDeleted.run(this.userId, id); } catch { /* ignore */ }
    this.broadcast('delete', { id });
  }
  widgetSettings(widgetId, payload) {
    this.broadcast('settings', payload, (c) => c.widgetId === widgetId);
  }
}

const hubs = new Map();
export function getHub(userId) {
  let h = hubs.get(userId);
  if (!h) {
    h = new UserHub(userId);
    hubs.set(userId, h);
  }
  return h;
}
export const peekHub = (userId) => hubs.get(userId);

export function heartbeat() {
  for (const h of hubs.values()) for (const c of h.clients) c.res.write(': ping\n\n');
}

// Live logs → that user's dashboards
logEvents.on('log', (row) => {
  if (!row.user_id) return;
  hubs.get(row.user_id)?.broadcast('log', row, (c) => c.kind === 'dashboard');
});

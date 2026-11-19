import crypto from 'node:crypto';
import { config, BROWSER_UA } from '../config.js';
import { getAccessToken } from '../auth.js';
import { db } from '../db.js';
import { Watcher } from './base.js';

const k = config.kick;
const API = 'https://api.kick.com/public/v1';
const EMOTE_RE = /\[emote:(\d+):([^\]]*)\]/g;
const BADGE_LABELS = {
  broadcaster: 'Broadcaster', moderator: 'Moderator', vip: 'VIP', og: 'OG', founder: 'Founder',
  verified: 'Verified', subscriber: 'Subscriber', sub_gifter: 'Sub Gifter', staff: 'Staff', sidekick: 'Sidekick',
};
const WEBHOOK_EVENTS = [
  'chat.message.sent', 'channel.subscription.new', 'channel.subscription.renewal',
  'channel.subscription.gifts', 'livestream.status.updated', 'channel.followed',
];

export function parseKickContent(content = '') {
  const parts = [];
  let last = 0;
  for (const m of content.matchAll(EMOTE_RE)) {
    if (m.index > last) parts.push({ type: 'text', text: content.slice(last, m.index) });
    parts.push({ type: 'emote', name: m[2], url: `https://files.kick.com/emotes/${m[1]}/fullsize` });
    last = m.index + m[0].length;
  }
  if (last < content.length) parts.push({ type: 'text', text: content.slice(last) });
  return parts;
}

// ── App access token (client credentials) — used for webhook subscriptions ──
let appToken = null;
let appTokenExp = 0;
async function getAppToken() {
  if (appToken && Date.now() < appTokenExp - 60_000) return appToken;
  const r = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: k.clientId, client_secret: k.clientSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Kick app token failed: ${j.error_description || j.error || r.status}`);
  appToken = j.access_token;
  appTokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return appToken;
}

export class KickWatcher extends Watcher {
  platform = 'kick';
  chatroomId = null;
  subBadges = [];
  ws = null;
  backoff = 2000;
  v2BlockedUntil = 0;
  warnedNoChat = false;
  channelNumId = null;   // Kick internal channel id → Pusher "channel.<id>" (FollowersUpdated)
  followSocket = false;  // true once we receive live follower totals over the socket

  get slug() { return this.account.channel_slug; }
  get broadcasterId() { return Number(this.account.channel_id); }

  start() {
    this.chatroomId = this.account.kick_chatroom_id ? Number(this.account.kick_chatroom_id) : null;
    this.channelNumId = this.account.kick_channel_id ? Number(this.account.kick_channel_id) : null;
    if (this.account.kick_followers != null) this.update({ followers: Number(this.account.kick_followers) });
    this.log('info', `Watching Kick channel "${this.slug}"`);
    this.update({ url: `https://kick.com/${this.slug}`, error: null });
    this.hub.kickBroadcasterId = this.broadcasterId;
    this.refreshStats().then(async () => {
      if (this.stopped) return;
      await this.ensureWebhooks();
      if (!this.stopped) this.connectChat();
    });
    this.every(k.statsPollMs, () => this.refreshStats());
  }

  onStop() {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  async api(path, { method = 'GET', body, app = false } = {}) {
    const token = app ? await getAppToken() : await getAccessToken(this.account.id);
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.message || `Kick API HTTP ${r.status}`), { status: r.status });
    return j;
  }

  /** Persist + publish the follower total. */
  setFollowers(n) {
    if (!Number.isFinite(n) || n < 0) return;
    db.prepare("UPDATE accounts SET kick_followers = ? WHERE id = ?").run(n, this.account.id);
    this.account.kick_followers = n;
    this.update({ followers: n });
  }

  /** Remember ids learned at runtime so they survive restarts. */
  saveIds({ chatroomId, channelId }) {
    let changed = false;
    if (channelId && !this.channelNumId) {
      this.channelNumId = Number(channelId);
      db.prepare('UPDATE accounts SET kick_channel_id = ? WHERE id = ?').run(this.channelNumId, this.account.id);
      changed = true;
    }
    if (chatroomId && !this.chatroomId) {
      this.chatroomId = Number(chatroomId);
      db.prepare('UPDATE accounts SET kick_chatroom_id = ? WHERE id = ?').run(this.chatroomId, this.account.id);
      changed = true;
    }
    if (changed && this.started) this.resubscribe();
  }

  // ── Stats: official API (live, viewers, subscribers) ────────────────
  async refreshStats() {
    const patch = {};
    try {
      const j = await this.api(`/channels?slug=${encodeURIComponent(this.slug)}`);
      const o = j.data?.[0];
      if (o) {
        const live = !!o.stream?.is_live;
        Object.assign(patch, {
          live,
          viewers: live ? o.stream.viewer_count ?? 0 : null,
          title: o.stream_title || null,
          subscribers: o.active_subscribers_count ?? null,
          error: null,
        });
      }
    } catch (e) {
      if (e.reconnect) { this.log('error', e.message); this.update({ error: e.message }); return this.stop(); }
      patch.error = `Kick API: ${e.message}`;
      this.log('warn', patch.error);
    }

    // Best effort: the unofficial endpoint has followers + chatroom id but is often
    // blocked by Cloudflare for servers. Retry it only every 15 minutes when blocked.
    if (Date.now() > this.v2BlockedUntil) {
      try {
        const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(this.slug)}`, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const v = await r.json();
        this.saveIds({ chatroomId: v.chatroom?.id, channelId: v.id });
        this.subBadges = (v.subscriber_badges || []).sort((a, b) => b.months - a.months);
        if (v.followers_count !== undefined) this.setFollowers(Number(v.followers_count));
      } catch {
        this.v2BlockedUntil = Date.now() + 15 * 60_000;
      }
    }

    // While live, the (deprecated but working) v1 livestreams endpoint exposes the internal channel_id.
    if (patch.live && !this.channelNumId) {
      try {
        const j = await this.api(`/livestreams?broadcaster_user_id=${this.broadcasterId}`);
        const ls = j.data?.[0];
        if (ls?.channel_id) this.saveIds({ channelId: ls.channel_id });
      } catch { /* optional */ }
    }

    if (this.stopped) return;
    const wasLive = this.hub.state.kick.live;
    if ('live' in patch && patch.live !== wasLive) this.log('info', patch.live ? `LIVE: "${patch.title || ''}"` : 'Stream ended');
    this.update(patch);
  }

  // ── Official webhooks (needs a public https URL set in the Kick app) ──
  async ensureWebhooks() {
    // Kick must be able to reach us: needs a public https APP_URL (deploy, or a tunnel like cloudflared/ngrok).
    if (!config.publicUrl.startsWith('https://') || /localhost|127\.0\.0\.1/.test(config.publicUrl)) {
      this.update({ webhookReady: false });
      return;
    }
    try {
      const list = await this.api(`/events/subscriptions?broadcaster_user_id=${this.broadcasterId}`, { app: true });
      const have = new Set((list.data || []).map((s) => s.event || s.name));
      const missing = WEBHOOK_EVENTS.filter((e) => !have.has(e));
      if (missing.length) {
        await this.api('/events/subscriptions', {
          method: 'POST', app: true,
          body: { method: 'webhook', broadcaster_user_id: this.broadcasterId, events: missing.map((name) => ({ name, version: 1 })) },
        });
        this.log('info', `Kick webhooks subscribed: ${missing.join(', ')}`);
      }
      this.webhooks = true;
      this.log('info', 'Kick chat: automatic via official webhooks');
      this.update({ chatConnected: true, chatMode: 'webhook', error: null });
    } catch (e) {
      this.log('warn', `Kick webhook subscription failed: ${e.message}. Check "Webhooks" is enabled with URL ${config.publicUrl}/webhooks/kick in your Kick app.`);
    }
  }

  // ── Badges ──
  badges(list = []) {
    return list.map((b) => {
      const out = { type: b.type, label: b.text || BADGE_LABELS[b.type] || b.type };
      if (b.type === 'subscriber') {
        const img = this.subBadges.find((x) => x.months <= (b.count || 1));
        if (img?.badge_image?.src) out.img = img.badge_image.src;
        out.label = `Subscriber (${b.count || 1} mo)`;
      }
      return out;
    });
  }

  // ── Kick's public Pusher socket: chat (chatrooms.<id>.v2) + follower totals (channel.<id>) ──
  socketChannels() {
    const list = [];
    if (this.chatroomId && !this.webhooks) list.push(`chatrooms.${this.chatroomId}.v2`); // webhooks already deliver chat
    if (this.channelNumId) list.push(`channel.${this.channelNumId}`);
    return list;
  }

  resubscribe() {
    if (this.ws && this.ws.readyState === 1) {
      for (const ch of this.socketChannels()) this.ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }));
    } else if (!this.ws) {
      this.connectChat();
    }
  }

  connectChat() {
    if (this.stopped) return;
    this.started = true;
    const channels = this.socketChannels();
    if (!channels.length) {
      if (this.webhooks) return; // chat arrives via webhooks
      if (!this.warnedNoChat) {
        this.warnedNoChat = true;
        this.log('warn', 'Kick chat not active: needs a public https APP_URL for automatic webhooks, or a Chatroom ID in Connections.');
        this.update({ chatMode: null });
      }
      return;
    }
    const ws = new WebSocket(`wss://ws-${k.pusherCluster}.pusher.com/app/${k.pusherKey}?protocol=7&client=js&version=8.4.0&flash=false`);
    this.ws = ws;
    let ping;
    ws.onopen = () => {
      ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })), 60_000);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      let d = m.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* keep */ } }
      switch (m.event) {
        case 'pusher:connection_established':
          for (const ch of this.socketChannels()) ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }));
          break;
        case 'pusher_internal:subscription_succeeded':
          this.backoff = 2000;
          if (String(m.channel).startsWith('chatrooms.')) {
            this.log('info', `Kick chat connected (chatroom ${this.chatroomId})`);
            this.update({ chatConnected: true, chatMode: 'pusher', error: null });
          } else {
            this.log('info', `Kick live follower updates connected (channel ${this.channelNumId})`);
          }
          break;
        case 'App\\Events\\FollowersUpdated':
          if (d?.followersCount != null) {
            this.followSocket = true;
            this.setFollowers(Number(d.followersCount));
          }
          break;
        case 'pusher:ping':
          ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          break;
        case 'pusher:error':
          this.log('warn', `Kick chat error: ${JSON.stringify(d)}`);
          break;
        case 'App\\Events\\ChatMessageEvent': {
          const sender = d.sender || {};
          const msg = {
            id: `kick-${d.id}`, platform: 'kick', ts: Date.parse(d.created_at) || Date.now(), kind: 'chat',
            author: { name: sender.username || 'Unknown', avatar: null, color: sender.identity?.color || null, badges: this.badges(sender.identity?.badges) },
            parts: parseKickContent(d.content),
          };
          if (d.type === 'reply' && d.metadata?.original_sender?.username) msg.replyTo = d.metadata.original_sender.username;
          this.hub.chat(msg);
          break;
        }
        case 'App\\Events\\MessageDeletedEvent':
          this.hub.remove(`kick-${d?.message?.id}`);
          break;
        case 'App\\Events\\SubscriptionEvent':
          this.hub.chat({
            id: `kick-sub-${Date.now()}-${d?.username}`, platform: 'kick', ts: Date.now(), kind: 'sub',
            author: { name: d?.username || 'Someone', avatar: null, color: null, badges: [] },
            eventText: `Subscribed${d?.months > 1 ? ` for ${d.months} months` : ''}!`, parts: [],
          });
          break;
        case 'App\\Events\\GiftedSubscriptionsEvent':
          this.hub.chat({
            id: `kick-gift-${Date.now()}-${d?.gifter_username}`, platform: 'kick', ts: Date.now(), kind: 'sub',
            author: { name: d?.gifter_username || 'Anonymous', avatar: null, color: null, badges: [] },
            eventText: `Gifted ${d?.gifted_usernames?.length || 1} subs!`, parts: [],
          });
          break;
        default:
          break;
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(ping);
      if (this.stopped) return;
      this.ws = null;
      this.update({ chatConnected: !!this.webhooks });
      this.log('warn', `Kick chat disconnected — reconnecting in ${this.backoff / 1000}s`);
      setTimeout(() => this.connectChat(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    };
  }
}

// ── Incoming webhooks: signature check + dispatch ──────────────────────
let publicKey = null;
let publicKeyAt = 0;
async function kickPublicKey(force = false) {
  if (publicKey && !force && Date.now() - publicKeyAt < 3_600_000) return publicKey;
  const r = await fetch(`${API}/public-key`, { headers: { Accept: 'application/json' } });
  const text = await r.text();
  let key = text;
  try { const j = JSON.parse(text); key = j.data?.public_key || j.public_key || text; } catch { /* PEM text */ }
  publicKey = key;
  publicKeyAt = Date.now();
  return publicKey;
}

export async function verifyKickWebhook(headers, rawBody) {
  const id = headers['kick-event-message-id'];
  const ts = headers['kick-event-message-timestamp'];
  const sig = headers['kick-event-signature'];
  if (!id || !ts || !sig) return false;
  const age = Math.abs(Date.now() - Date.parse(ts));
  if (!Number.isFinite(age) || age > 10 * 60_000) return false; // replay protection
  const data = Buffer.from(`${id}.${ts}.${rawBody}`);
  const check = (key) => {
    try { return crypto.verify('sha256', data, key, Buffer.from(sig, 'base64')); } catch { return false; }
  };
  if (check(await kickPublicKey())) return true;
  return check(await kickPublicKey(true)); // key may have rotated
}

const seenWebhookIds = new Set();
/** Convert a verified webhook into hub events. `getHubForUser` avoids a circular import. */
export function handleKickWebhook(type, payload, messageId, getHubForUser) {
  if (seenWebhookIds.has(messageId)) return;
  seenWebhookIds.add(messageId);
  if (seenWebhookIds.size > 5000) seenWebhookIds.delete(seenWebhookIds.values().next().value);

  const broadcasterId = payload?.broadcaster?.user_id;
  if (!broadcasterId) return;
  const acc = db.prepare("SELECT user_id FROM accounts WHERE provider = 'kick' AND channel_id = ?").get(String(broadcasterId));
  if (!acc) return;
  const hub = getHubForUser(acc.user_id);
  const watcher = hub.watchers.kick;
  const user = (u) => ({ name: u?.username || 'Anonymous', avatar: u?.profile_picture || null, color: u?.identity?.username_color || null });

  switch (type) {
    case 'chat.message.sent': {
      const s = payload.sender || {};
      const msg = {
        id: `kick-${payload.message_id}`, platform: 'kick', ts: Date.parse(payload.created_at) || Date.now(), kind: 'chat',
        author: { ...user(s), badges: watcher ? watcher.badges(s.identity?.badges) : (s.identity?.badges || []).map((b) => ({ type: b.type, label: b.text || b.type })) },
        parts: parseKickContent(payload.content || ''),
      };
      if (payload.replies_to?.sender?.username) msg.replyTo = payload.replies_to.sender.username;
      hub.chat(msg);
      break;
    }
    case 'channel.subscription.new':
    case 'channel.subscription.renewal':
      hub.chat({
        id: `kick-wh-${messageId}`, platform: 'kick', ts: Date.now(), kind: 'sub',
        author: { ...user(payload.subscriber), badges: [] },
        eventText: type.endsWith('renewal') ? `Resubscribed${payload.duration > 1 ? ` (${payload.duration} months)` : ''}!` : 'Subscribed!', parts: [],
      });
      break;
    case 'channel.subscription.gifts':
      hub.chat({
        id: `kick-wh-${messageId}`, platform: 'kick', ts: Date.now(), kind: 'sub',
        author: { ...user(payload.gifter), badges: [] },
        eventText: `Gifted ${payload.giftees?.length || 1} subs!`, parts: [],
      });
      break;
    case 'channel.followed':
      // Exact totals come from the socket when available; otherwise count up from the last known total.
      if (watcher && !watcher.followSocket && hub.state.kick.followers != null) watcher.setFollowers(hub.state.kick.followers + 1);
      break;
    case 'livestream.status.updated':
      hub.update('kick', { live: !!payload.is_live, title: payload.title || hub.state.kick.title, viewers: payload.is_live ? hub.state.kick.viewers ?? 0 : null });
      hub.log('info', 'kick', payload.is_live ? `LIVE: "${payload.title || ''}"` : 'Stream ended');
      break;
    default:
      break;
  }
}

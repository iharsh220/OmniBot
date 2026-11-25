// Kick: official API stats (pulled on demand) + chat/events via signed official webhooks.
import crypto from 'node:crypto';
import { config, tfetch } from './config.js';
import { getAccessToken, getUser, getSystemKickBotToken, getSystemKickBot } from './auth.js';
import * as db from './store.js';

const API = 'https://api.kick.com/public/v1';
const EMOTE_RE = /\[emote:(\d+):([^\]]*)\]/g;
const WEBHOOK_EVENTS = ['chat.message.sent', 'channel.subscription.new', 'channel.subscription.renewal', 'channel.subscription.gifts', 'livestream.status.updated', 'channel.followed'];
const BADGE_LABELS = { broadcaster: 'Broadcaster', moderator: 'Moderator', vip: 'VIP', og: 'OG', founder: 'Founder', verified: 'Verified', subscriber: 'Subscriber', sub_gifter: 'Sub Gifter', staff: 'Staff' };

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

let appToken = null;
let appTokenExp = 0;
async function getAppToken() {
  if (appToken && Date.now() < appTokenExp - 60_000) return appToken;
  const r = await tfetch('https://id.kick.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.kick.clientId, client_secret: config.kick.clientSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Kick app token failed: ${j.error_description || j.error || r.status}`);
  appToken = j.access_token;
  appTokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return appToken;
}

async function api(uid, path, { method = 'GET', body, app = false } = {}) {
  const token = app ? await getAppToken() : await getAccessToken(uid, 'kick');
  const r = await tfetch(API + path, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Kick API HTTP ${r.status}`);
  return j;
}

const isPublicUrl = () => config.appUrl.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(config.appUrl);
export const kickDue = (st, now) => now >= (st._nextStatsAt || 0) || (isPublicUrl() && now >= (st._nextWebhookCheckAt || 0));

/** Mutates ctx.st (state.kick); may set ctx.accPatch to persist learned ids. */
export async function kickStep(ctx, acc) {
  const st = ctx.st;
  const now = Date.now();
  Object.assign(st, { connected: true, channelName: acc.channelName, avatar: acc.avatar, url: `https://kick.com/${acc.channelSlug}` });
  const L = (level, message) => ctx.logs.push({ level, source: 'kick', message });

  // Ask Kick to send chat/events to our webhook (re-checked daily). Needs a public https URL.
  if (isPublicUrl() && now >= (st._nextWebhookCheckAt || 0)) {
    st._nextWebhookCheckAt = now + 24 * 3600_000;
    try {
      const bid = Number(acc.channelId);
      const list = await api(ctx.uid, `/events/subscriptions?broadcaster_user_id=${bid}`, { app: true });
      const have = new Set((list.data || []).map((s) => s.event || s.name));
      const missing = WEBHOOK_EVENTS.filter((e) => !have.has(e));
      if (missing.length) {
        await api(ctx.uid, '/events/subscriptions', { method: 'POST', app: true, body: { method: 'webhook', broadcaster_user_id: bid, events: missing.map((name) => ({ name, version: 1 })) } });
        L('info', `Kick webhooks subscribed: ${missing.join(', ')}`);
      }
      Object.assign(st, { chatConnected: true, chatMode: 'webhook' });
    } catch (e) {
      st._nextWebhookCheckAt = now + 10 * 60_000;
      L('warn', `Kick webhook subscription failed: ${e.message}. In your Kick app enable Webhooks with URL ${config.appUrl}/webhooks/kick`);
    }
  }

  if (now < (st._nextStatsAt || 0)) return;
  st._nextStatsAt = now + config.kickStatsMs;
  try {
    const o = (await api(ctx.uid, `/channels?slug=${encodeURIComponent(acc.channelSlug)}`)).data?.[0];
    if (o) {
      const live = !!o.stream?.is_live;
      if (live !== !!st.live) L('info', live ? `LIVE: "${o.stream_title || ''}"` : 'Stream ended');
      Object.assign(st, { _startedAt: live && Date.parse(o.stream.start_time) > 1e12 ? Date.parse(o.stream.start_time) : null, _image: o.stream?.thumbnail || null, game: live ? o.category?.name || null : null });
      Object.assign(st, { live, viewers: live ? o.stream.viewer_count ?? 0 : null, title: o.stream_title || null, subscribers: o.active_subscribers_count ?? null, error: null });
      if (live && !acc.kickChannelId) {
        try {
          const ls = (await api(ctx.uid, `/livestreams?broadcaster_user_id=${Number(acc.channelId)}`)).data?.[0];
          if (ls?.channel_id) ctx.accPatch = { kickChannelId: Number(ls.channel_id) };
        } catch { /* optional */ }
      }
    }
  } catch (e) {
    st.error = e.reconnect ? e.message : `Kick API: ${e.message}`;
    L(e.reconnect ? 'error' : 'warn', st.error);
  }
}

/** Is this Kick channel live right now? (Discord announcements) */
export async function kickChannel(uid, acc) {
  const o = (await api(uid, `/channels?slug=${encodeURIComponent(acc.channelSlug)}`)).data?.[0];
  if (!o) return null;
  const start = Date.parse(o.stream?.start_time);
  return { live: !!o.stream?.is_live, title: o.stream_title || null, start: start > 1e12 ? start : null, image: o.stream?.thumbnail || null, game: o.category?.name || null, viewers: o.stream?.viewer_count ?? null };
}

// ── Webhooks ──
let publicKey = null;
let publicKeyAt = 0;
async function kickPublicKey(force = false) {
  if (publicKey && !force && Date.now() - publicKeyAt < 3_600_000) return publicKey;
  const text = await (await tfetch(`${API}/public-key`, { headers: { Accept: 'application/json' } })).text();
  let key = text;
  try { const j = JSON.parse(text); key = j.data?.public_key || j.public_key || text; } catch { /* PEM text */ }
  publicKey = key;
  publicKeyAt = Date.now();
  return key;
}

/** RSA-SHA256 over "messageId.timestamp.body" with Kick's public key + 10-min replay window. */
export async function verifyKickWebhook(headers, rawBody) {
  const id = headers['kick-event-message-id'];
  const ts = headers['kick-event-message-timestamp'];
  const sig = headers['kick-event-signature'];
  if (!id || !ts || !sig) return false;
  const age = Math.abs(Date.now() - Date.parse(ts));
  if (!Number.isFinite(age) || age > 10 * 60_000) return false;
  const data = Buffer.from(`${id}.${ts}.${rawBody}`);
  const check = (key) => { try { return crypto.verify('sha256', data, key, Buffer.from(sig, 'base64')); } catch { return false; } };
  if (check(await kickPublicKey())) return true;
  return check(await kickPublicKey(true)); // key may have rotated
}

/** Turn a verified webhook into { uid, user, chats, statePatch, followersDelta, logs } (or null). */
export async function webhookToEvents(type, payload, messageId) {
  const bid = payload?.broadcaster?.user_id;
  if (!bid) return null;
  const link = await db.get(`link/kick/${bid}`);
  if (!link) return null;
  const user = await getUser(link.uid);
  if (!user) return null;
  const who = (u) => ({ name: u?.username || 'Anonymous', avatar: u?.profile_picture || null, color: u?.identity?.username_color || null });
  const out = { uid: link.uid, user, chats: [], statePatch: null, followersDelta: 0, logs: [] };
  switch (type) {
    case 'chat.message.sent': {
      const s = payload.sender || {};
      const msg = {
        id: `kick-${payload.message_id}`, platform: 'kick', ts: Date.parse(payload.created_at) || Date.now(), kind: 'chat',
        author: { ...who(s), badges: (s.identity?.badges || []).map((b) => ({ type: b.type, label: b.type === 'subscriber' ? `Subscriber (${b.count || 1} mo)` : b.text || BADGE_LABELS[b.type] || b.type })) },
        parts: parseKickContent(payload.content || ''),
      };
      if (payload.replies_to?.sender?.username) msg.replyTo = payload.replies_to.sender.username;
      out.chats.push(msg);
      break;
    }
    case 'channel.subscription.new':
    case 'channel.subscription.renewal':
      out.chats.push({ id: `kick-wh-${messageId}`, platform: 'kick', ts: Date.now(), kind: 'sub', alert: 'sub', months: payload.duration || 1, author: { ...who(payload.subscriber), badges: [] }, parts: [],
        eventText: type.endsWith('renewal') ? `Resubscribed${payload.duration > 1 ? ` (${payload.duration} months)` : ''}!` : 'Subscribed!' });
      break;
    case 'channel.subscription.gifts':
      out.chats.push({ id: `kick-wh-${messageId}`, platform: 'kick', ts: Date.now(), kind: 'sub', alert: 'gift', count: payload.giftees?.length || 1, author: { ...who(payload.gifter), badges: [] }, parts: [],
        eventText: `Gifted ${payload.giftees?.length || 1} subs!` });
      break;
    case 'channel.followed':
      out.followersDelta = 1;
      // also an event, so the Alerts widget (and chat, if "events" are shown) can say "new follower"
      out.chats.push({ id: `kick-wh-${messageId}`, platform: 'kick', ts: Date.now(), kind: 'follow', alert: 'follow', author: { ...who(payload.follower), badges: [] }, parts: [], eventText: 'Followed!' });
      break;
    case 'livestream.status.updated':
      out.statePatch = { live: !!payload.is_live, title: payload.title || null, _nextStatsAt: 0 };
      out.logs.push({ level: 'info', source: 'kick', message: payload.is_live ? `LIVE: "${payload.title || ''}"` : 'Stream ended' });
      break;
    default:
      return null;
  }
  return out;
}

/** Post a chat message in a channel as the shared OmniChat Kick bot (needs chat:write). Max 500 chars. */
export async function postKickChat(broadcasterUserId, text) {
  const token = await getSystemKickBotToken();
  const r = await tfetch(`${API}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ broadcaster_user_id: Number(broadcasterUserId), content: String(text).slice(0, 500), type: 'user' }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.message || `Kick chat HTTP ${r.status}`);
  }
}
export const kickBotReady = async () => {
  const bot = await getSystemKickBot();
  return !!(bot?.scope && String(bot.scope).split(/\s+/).includes('chat:write'));
};

// Discord announcements: YouTube live / videos / Shorts / posts and Kick live, posted by the OmniChat Discord bot.
//
// How a live stream is noticed (fastest first, every path ends in announce(), which posts each stream ONCE):
//   1. Kick webhook (livestream.status.updated)
//   2. OBS: an OmniChat overlay hears "Start Streaming" and asks the server to check (POST /api/w/:id/obs)
//   3. YouTube push (WebSub) + the normal overlay/dashboard polling (engine.tick)
//   4. a 1-minute scheduler (GET /api/cron/discord)
// Only official APIs are used here. Public streams and videos only.
//
// Where: nobody types a channel ID. The streamer's server is linked once (one click "Add to Discord": Discord itself
// proves that the streamer manages that server; the owner's server is found automatically). Inside that server OmniChat
// posts in every channel the bot was ADDED to, and the channel's name says what: youtube / kick / both.
// A streamer can never post in a server that is not linked to them (the bot may mention everyone!).
import crypto from 'node:crypto';
import * as db from './store.js';
import { config, tfetch } from './config.js';
import { dapi, botId, botGuilds, guildChannels, plain, has, INVITE_PERMISSIONS } from './discord-api.js';
import { decrypt, encrypt, randomToken, sha256, safeEqual } from './crypto.js';
import { getAccessToken, getUser, updateUser, listAccounts, normalizeAccounts } from './auth.js';
import { addLogs } from './feed.js';
import { getEggChannelId } from './eggs.js';
import { activeBroadcasts, videosByIds, uploadIds } from './youtube.js';
import { kickChannel } from './kick.js';

const MIN = 60_000;
const HUB = 'https://pubsubhubbub.appspot.com/subscribe';

export const TYPES = ['live', 'video', 'short', 'post', 'kick'];
export const PINGS = ['both', 'everyone', 'here', 'none'];
const LABEL = { live: 'YouTube live', video: 'YouTube video', short: 'YouTube Short', post: 'Post', kick: 'Kick live' };
const NO_CHANNEL = 'No channel found: add the OmniChat bot to a channel of your server first';
const COLOR = { live: 0xff0033, video: 0xff0033, short: 0xff0033, post: 0x6d4aff, kick: 0x53fc18 };
const BUTTON = { live: 'Watch live', video: 'Watch video', short: 'Watch Short', post: 'Open link', kick: 'Watch on Kick' };
const TEXT = {
  live: '**{name}** is LIVE on YouTube!', video: '**{name}** uploaded a new video!', short: '**{name}** posted a new Short!',
  post: '', kick: '**{name}** is LIVE on Kick!',
};
export const MODES = ['off', 'youtube', 'kick', 'both'];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, n);

// ── The streamer's Discord server ──
const isOwner = (user) => listAccounts(user, 'youtube').some((a) => config.discord.streamers.includes(String(a.channelId)));
/** Can this streamer use announcements at all? (the owner, or anyone once "Add to Discord" is configured) */
export const discordAvailable = (user) => !!config.discord.botToken && listAccounts(user, 'youtube').concat(listAccounts(user, 'kick')).length > 0 && (isOwner(user) || !!config.discord.clientSecret);
const linked = (user) => !!config.discord.botToken && !!user?.discord?.guildId;

/** The owner's server needs no click: it is the one with the egg feed, or the only one the bot is in. */
async function linkOwner(user) {
  if (linked(user) || !config.discord.botToken || !isOwner(user)) return user;
  let gid = (await db.get('system/discord'))?.ownerGuild || null;
  if (!gid) {
    const egg = await getEggChannelId();
    if (egg) gid = (await dapi(`/channels/${egg}`).catch(() => null))?.guild_id || null;
  }
  if (!gid) { const list = await botGuilds(); if (list.length === 1) gid = list[0].id; }
  if (!gid) return user;
  const g = await dapi(`/guilds/${gid}`);
  await db.update('system/discord', (S) => { S.ownerGuild = gid; return S; }, { uids: [] });
  return updateUser(user.id, (u) => (u ? { ...u, discord: { ...(u.discord || {}), guildId: gid, guildName: clean(g.name, 100) } } : undefined));
}
const redirect = () => `${config.appUrl}/auth/discord/callback`;
/** "Add to Discord": Discord's own page where the streamer picks one of THEIR servers. */
export async function inviteUrl(uid) {
  const state = randomToken();
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: await botId(), scope: 'bot identify', permissions: INVITE_PERMISSIONS, response_type: 'code', redirect_uri: redirect(), state });
  return { url: url.href, cookie: encrypt(JSON.stringify({ state, uid, exp: Date.now() + 10 * MIN })) };
}
/** Back from Discord. The token answer names the server the code was granted for, so it can't be faked in the URL. */
export async function finishInvite(user, cookieValue, q) {
  let st = null;
  try { st = JSON.parse(decrypt(cookieValue) || 'null'); } catch { /* invalid */ }
  if (!st || st.uid !== user.id || st.exp < Date.now() || !safeEqual(st.state, q.state)) throw bad('Discord login expired — please try again.');
  if (q.error || typeof q.code !== 'string') throw bad('Discord was not connected.');
  const r = await tfetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: redirect(), client_id: await botId(), client_secret: config.discord.clientSecret }) }, 8000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.guild?.id) throw bad(`Discord did not confirm the server${j.error_description ? `: ${clean(j.error_description, 80)}` : ''}`);
  await updateUser(user.id, (u) => (u ? { ...u, discord: { ...(u.discord || {}), guildId: String(j.guild.id), guildName: clean(j.guild.name, 100), modes: {} } } : undefined));
  return clean(j.guild.name, 100);
}
export async function unlinkDiscord(user) {
  await updateUser(user.id, (u) => { if (!u) return undefined; delete u.discord; return u; });
  await registerDiscord(user.id, false);
}

/** What a channel is for, from its name. A channel that says neither (and isn't an announcement channel) stays off. */
export function autoMode(name) {
  const n = plain(name);
  const yt = /you.?tube|(^|[^a-z])yt([^a-z]|$)/.test(n);
  const kick = /kick/.test(n);
  if (yt && kick) return 'both';
  if (yt || kick) return yt ? 'youtube' : 'kick';
  return /announce|notif|stream|(^|[^a-z])live([^a-z]|$)/.test(n) ? 'both' : 'off';
}
/** Channels the bot was added to (or the streamer picked from the list), with what is posted there. */
async function channelsOf(user, opts) {
  if (!linked(user)) return { list: [], others: [] };
  const modes = user.discord.modes || {};
  const egg = await getEggChannelId();
  const all = (await guildChannels(user.discord.guildId, opts)).filter((c) => c.id !== egg); // never the egg feed itself
  const list = all.filter((c) => c.explicit || modes[c.id]).map((c) => {
    const auto = c.explicit ? autoMode(c.name) : 'off';
    return { id: c.id, name: c.name, auto, mode: modes[c.id] || auto, chosen: !!modes[c.id], missing: c.missing };
  });
  const others = all.filter((c) => !c.explicit && !modes[c.id] && has(c.perms, 'View Channel') && has(c.perms, 'Send Messages')).map((c) => ({ id: c.id, name: c.name }));
  return { list, others };
}
async function targets(user, type) {
  const want = type === 'kick' ? 'kick' : 'youtube';
  return (await channelsOf(user)).list.filter((c) => c.mode === want || c.mode === 'both').slice(0, 5);
}

// ── Settings ──
export function discordSettings(user) {
  const s = user?.discord || {};
  return { enabled: !!s.enabled, since: s.since || 0, types: Object.fromEntries(TYPES.map((t) => [t, { on: true, ping: 'both', text: TEXT[t], ...(s.types?.[t] || {}) }])) };
}
/** → the new `user.discord` (the server link itself is never taken from the request). */
export async function validateDiscord(b, user) {
  if (!linked(user)) throw bad('Add OmniChat to your Discord server first');
  const cur = discordSettings(user);
  const next = { ...(user.discord || {}), ...structuredClone(cur), modes: { ...(user.discord.modes || {}) } };
  if (b.enabled !== undefined) next.enabled = !!b.enabled;
  for (const t of TYPES) {
    const x = b.types?.[t];
    if (!x || typeof x !== 'object') continue;
    if (x.on !== undefined) next.types[t].on = !!x.on;
    if (x.ping !== undefined) { if (!PINGS.includes(x.ping)) throw bad('Unknown ping'); next.types[t].ping = x.ping; }
    if (x.text !== undefined && t !== 'post') next.types[t].text = clean(x.text, 300) || TEXT[t];
  }
  if (b.modes && typeof b.modes === 'object') {
    const { list, others } = await channelsOf(user, { fresh: true });
    const known = new Set([...list, ...others].map((c) => c.id)); // only channels of the linked server
    for (const [id, mode] of Object.entries(b.modes).slice(0, 50)) {
      if (!known.has(id)) throw bad('That channel is not in your server');
      if (mode === 'auto') delete next.modes[id];
      else if (MODES.includes(mode)) next.modes[id] = mode;
      else throw bad('Unknown channel setting');
    }
  }
  // Nothing older than the moment it was switched on is ever announced.
  if (next.enabled && !cur.enabled) next.since = Date.now();
  return next;
}

const fill = (text, ev) => text.replace(/\{(name|title|url)\}/g, (_, k) => clean(ev[k], 200));
const httpsOnly = (u) => (/^https:\/\/[^\s<>"]+$/.test(String(u || '')) ? String(u).slice(0, 500) : null);
export function buildMessage(s, ev, { test = false } = {}) {
  const t = s.types[ev.type];
  const ping = { both: '@everyone @here', everyone: '@everyone', here: '@here', none: '' }[t.ping];
  const body = ev.type === 'post' ? ev.text : fill(t.text, ev);
  const url = httpsOnly(ev.url);
  const image = httpsOnly(ev.image);
  return {
    content: [test ? '`TEST`' : '', ping, body].filter(Boolean).join(ev.type === 'post' ? '\n' : ' ').slice(0, 2000),
    // only these mentions can ever ping, whatever a title or text contains
    allowed_mentions: { parse: t.ping === 'none' ? [] : ['everyone'] },
    ...(ev.type === 'post' ? {} : { embeds: [{
      title: clean(ev.title, 250) || LABEL[ev.type], url: url || undefined, color: COLOR[ev.type],
      author: ev.name ? { name: clean(ev.name, 100), icon_url: httpsOnly(ev.avatar) || undefined } : undefined,
      description: ev.game ? `Playing **${clean(ev.game, 80)}**` : undefined,
      image: image ? { url: image } : undefined,
      footer: { text: `OmniChat • ${LABEL[ev.type]}` }, timestamp: new Date(ev.start || Date.now()).toISOString(),
    }] }),
    ...(url ? { components: [{ type: 1, components: [{ type: 2, style: 5, label: BUTTON[ev.type], url }] }] } : {}),
  };
}
async function send(channel, payload, { nonce, file } = {}) {
  // enforce_nonce: if our first try did arrive, Discord returns that message instead of posting a second one
  const json = { ...payload, ...(nonce ? { nonce, enforce_nonce: true } : {}) };
  if (!file) return dapi(`/channels/${channel}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
  const form = new FormData();
  form.append('payload_json', JSON.stringify(json));
  form.append('files[0]', new Blob([file.buf], { type: file.type }), file.name);
  return dapi(`/channels/${channel}/messages`, { method: 'POST', body: form });
}

// ── One announcement per stream / video and channel ──
const KEY = (uid) => `discord/${uid}`;
const isLive = (type) => type === 'live' || type === 'kick';
/** The same live stream, seen through another path (different id / rounded start time / manual button)? */
const sameStream = (x, ev, now) => x.type === ev.type && x.ch === ev.ch && (x.state === 'sent' || x.state === 'sending')
  && (Math.abs((x.start || x.at) - ev.start) < 5 * MIN || now - x.at < (x.manual ? 30 : 15) * MIN);

async function claim(uid, ev) {
  let got = false;
  await db.update(KEY(uid), (D) => {
    got = false; // may re-run on an etag conflict
    const now = Date.now();
    D.done ||= [];
    const same = D.done.find((x) => x.k === ev.key);
    if (same) {
      const retry = (same.state === 'failed' && now - same.at > 20_000) || (same.state === 'sending' && now - same.at > 45_000);
      if (!retry || same.tries >= 3) return undefined;
      Object.assign(same, { state: 'sending', at: now, tries: same.tries + 1 });
      got = true;
      return D;
    }
    if (isLive(ev.type)) {
      const near = D.done.find((x) => sameStream(x, ev, now));
      if (near) {
        if (near.state === 'sending') return undefined; // decide when that one is finished
        D.done.push({ k: ev.key, ch: ev.ch, type: ev.type, start: ev.start, at: now, state: 'skipped', tries: 0 });
        return D;
      }
    }
    D.done = [...D.done, { k: ev.key, ch: ev.ch, type: ev.type, start: ev.start || now, at: now, state: 'sending', tries: 1, ...(ev.manual ? { manual: true } : {}) }].slice(-200);
    got = true;
    return D;
  }, {});
  return got;
}
async function finish(uid, ev, result) {
  await db.update(KEY(uid), (D) => {
    const now = Date.now();
    const x = (D.done || []).find((d) => d.k === ev.key);
    if (x) Object.assign(x, { state: result.error ? 'failed' : 'sent', at: now });
    D.history = [{
      ts: now, type: ev.type, channel: ev.chName, title: clean(ev.title || ev.text, 120), url: httpsOnly(ev.url), source: ev.source, ok: !result.error,
      error: result.error || null, late: ev.start && isLive(ev.type) && !ev.manual ? Math.max(0, Math.round((now - ev.start) / 1000)) : null, messageId: result.id || null,
    }, ...(D.history || [])].slice(0, 40);
    return D;
  }, {});
}

/**
 * Post one announcement in every matching channel (if it is switched on and was not posted there before).
 * ev: { type, key, start, title, url, image, name, avatar, game, text, source, manual }
 * Returns 'sent' | 'failed' | 'already' | 'off' | 'old' | 'nochannel'.
 */
export async function announce(user, ev, { file } = {}) {
  if (!linked(user)) return 'off';
  const s = discordSettings(user);
  if (!s.types[ev.type].on || (!s.enabled && !ev.manual)) return 'off';
  // Streams that began long ago (feature switched on mid-stream, server was down) are not news any more.
  if (isLive(ev.type) && !ev.manual && Date.now() - ev.start > 30 * MIN) return 'old';
  const channels = await targets(user, ev.type);
  if (!channels.length) return 'nochannel';
  const postIn = async (c) => {
    const one = { ...ev, key: `${ev.key}@${c.id}`, ch: c.id, chName: c.name };
    if (!(await claim(user.id, one))) return 'already';
    let result;
    try {
      result = { id: (await send(c.id, buildMessage(s, ev), { nonce: sha256(`${user.id}|${one.key}`).slice(0, 25), file })).id };
    } catch (e) { result = { error: `#${c.name}: ${e.message}${c.missing.length ? ` (missing: ${c.missing.join(', ')})` : ''}` }; }
    await finish(user.id, one, result);
    await addLogs(user.id, [result.error
      ? { level: 'error', source: 'discord', message: `${LABEL[ev.type]} announcement failed in ${result.error}` }
      : { level: 'info', source: 'discord', message: `Announced in #${c.name}: ${LABEL[ev.type]}${ev.title ? ` "${clean(ev.title, 80)}"` : ''} (${ev.source})` }]);
    return result.error ? 'failed' : 'sent';
  };
  const results = [];
  for (const c of channels) results.push(await postIn(c));
  return ['failed', 'sent', 'already'].find((r) => results.includes(r));
}
/** Announce, but never let a Discord problem break chat polling or a webhook. */
const safely = async (work, uid) => { try { return await work(); } catch (e) { console.warn('[discord]', uid, e.message); return 'failed'; } };

// ── Where announcements come from ──
const ytAcc = (user) => listAccounts(user, 'youtube')[0];
const kickAcc = (user) => listAccounts(user, 'kick')[0];
const ytLive = (user, b, source) => ({
  type: 'live', key: `yt:${b.id}`, start: b.start || Date.now(), title: b.title, url: `https://www.youtube.com/watch?v=${b.id}`, image: b.image,
  name: ytAcc(user).channelName, avatar: ytAcc(user).avatar, source,
});
const kickLive = (user, k, source) => {
  const acc = kickAcc(user);
  const start = k.start || Date.now();
  return { type: 'kick', key: `kick:${Math.round(start / MIN)}`, start, title: k.title, url: `https://kick.com/${encodeURIComponent(acc.channelSlug)}`, image: k.image, game: k.game, name: acc.channelName, avatar: acc.avatar, source };
};

/** engine.tick: the overlay/dashboard polling found a live stream. Remembers it in the state, so it costs nothing afterwards. */
export async function announceFromTick(user, states) {
  if (!user.discord?.enabled || !linked(user)) return;
  const settled = (r) => r !== 'failed';
  const y = states.youtube;
  if (y?.live && y._official && y._privacy === 'public' && y._announced !== y._videoId) {
    const r = await safely(() => announce(user, ytLive(user, { id: y._videoId, title: y.title, start: y._startedAt, image: y._image }, 'polling')), user.id);
    if (settled(r)) y._announced = y._videoId;
  }
  const k = states.kick;
  if (k?.live && k._startedAt && k._announced !== k._startedAt) {
    const r = await safely(() => announce(user, kickLive(user, { title: k.title, start: k._startedAt, image: k._image, game: k._game }, 'polling')), user.id);
    if (settled(r)) k._announced = k._startedAt;
  }
}
/** Kick told us directly. The picture / game are a bonus: a slow API must not delay the ping. */
export async function announceKickWebhook(user, payload) {
  if (!payload?.is_live || !user.discord?.enabled || !linked(user)) return;
  await safely(async () => {
    const info = await Promise.race([kickChannel(user.id, kickAcc(user)).catch(() => null), new Promise((r) => setTimeout(r, 1500, null))]);
    return announce(user, kickLive(user, { title: payload.title || info?.title, start: Date.parse(payload.started_at) || Date.now(), image: info?.image, game: info?.game }, 'Kick webhook'));
  }, user.id);
}

/** A valid YouTube token without another database read when the loaded user already has one. */
async function ytToken(user) {
  const a = ytAcc(user);
  if (a?.expiresAt && Date.now() < a.expiresAt - 5 * MIN) { const t = decrypt(a.accessToken); if (t) return t; }
  return getAccessToken(user.id, 'youtube');
}
/** Ask YouTube and/or Kick right now. → { youtube, kick }: live? (null = not connected / could not check) */
export async function checkLive(user, source, { youtube = true, kick = true } = {}) {
  const out = { youtube: null, kick: null };
  await Promise.all([
    (async () => {
      if (!youtube || !ytAcc(user)) return;
      const list = (await activeBroadcasts(await ytToken(user))).filter((b) => b.privacy === 'public');
      out.youtube = list.length > 0;
      for (const b of list) await announce(user, ytLive(user, b, source));
    })().catch((e) => { out.error = `YouTube: ${e.message}`; out.quota = e.reason === 'quotaExceeded'; }),
    (async () => {
      if (!kick || !kickAcc(user)) return;
      const k = await kickChannel(user.id, kickAcc(user));
      out.kick = !!k?.live;
      if (k?.live && k.start) await announce(user, kickLive(user, k, source));
    })().catch((e) => { out.error = [out.error, `Kick: ${e.message}`].filter(Boolean).join(' · '); }),
  ]);
  return out;
}

/**
 * An overlay inside OBS heard "Start Streaming": check every few seconds for 3 minutes (the overlay keeps asking).
 * The widget URL is the only secret here, so the number of checks is capped to protect the YouTube quota.
 */
export async function obsSignal(user, event) {
  if (!user.discord?.enabled || !linked(user)) return { more: false };
  let go = false;
  let active = false;
  await db.update(KEY(user.id), (D) => {
    go = false;
    active = false;
    const now = Date.now();
    const B = D.burst || { until: 0, starts: [] };
    const started = event === 'start' && now > B.until;
    if (started) {
      B.starts = B.starts.filter((t) => t > now - 60 * MIN);
      if (B.starts.length >= 8) return undefined;
      B.starts.push(now);
      B.until = now + 3 * MIN;
      D.obsAt = now;
    }
    active = now < B.until;
    D.burst = B;
    if (!active || now - (D.checkAt || 0) < 3500) return started ? D : undefined; // several overlays ask at once → one check
    D.checkAt = now;
    go = true;
    return D;
  }, {});
  if (!go) return { more: active };
  const r = await checkLive(user, 'OBS');
  const found = (r.youtube || !ytAcc(user)) && (r.kick || !kickAcc(user));
  // start reading chat at once too, instead of waiting for the next minute's check
  if (r.youtube) await db.update(`live/${user.id}`, (L) => { if (!L.youtube || L.youtube.live) return undefined; L.youtube._nextLiveCheckAt = 0; return L; }, { youtube: {}, kick: {} });
  if (found || r.quota) await db.update(KEY(user.id), (D) => { if (D.burst) D.burst.until = 0; return D; }, {});
  return { more: !found && !r.quota };
}

// ── New videos and Shorts (YouTube push + a slow fallback) ──
const seconds = (iso) => { const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || ''); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0; };
/** YouTube's API does not say "Short": up to 3 min and upright (or #shorts in the title) counts as one. */
export function isShort(v) {
  if (v.duration > 180) return false;
  if (/#shorts?\b/i.test(v.title)) return true;
  return v.width && v.height ? v.height >= v.width : true;
}
async function handleVideos(user, ids, source) {
  const s = discordSettings(user);
  for (const v of await videosByIds(await ytToken(user), ids)) {
    if (v.channelId !== ytAcc(user).channelId || v.privacy !== 'public' || v.broadcast === 'upcoming') continue;
    if (v.broadcast === 'live') { await announce(user, ytLive(user, { id: v.id, title: v.title, start: v.start, image: v.image }, source)); continue; }
    v.duration = seconds(v.durationIso);
    if (v.wasLive || !v.duration) continue; // a finished stream, or still processing (the fallback looks again)
    if (v.published < s.since || Date.now() - v.published > 24 * 60 * MIN) continue; // only new uploads (edits push too)
    const type = isShort(v) ? 'short' : 'video';
    await announce(user, {
      type, key: `yt:${v.id}`, start: v.published, title: v.title, image: v.image, name: ytAcc(user).channelName, avatar: ytAcc(user).avatar, source,
      url: type === 'short' ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
    });
  }
}

const topicFor = (user) => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${ytAcc(user).channelId}`;
const publicUrl = () => /^https:\/\//.test(config.appUrl) && !/localhost|127\.0\.0\.1/.test(config.appUrl);
/** (Re)subscribe to YouTube's upload push; the lease lasts some days and is renewed 2 days before it ends. */
export async function ensurePush(user, D) {
  if (!publicUrl() || !ytAcc(user)) return;
  const doc = D || (await db.get(KEY(user.id))) || {};
  const now = Date.now();
  const topic = topicFor(user);
  if (doc.push?.topic === topic && ((doc.push.leaseUntil || 0) > now + 2 * 24 * 60 * MIN || now - (doc.push.askedAt || 0) < 60 * MIN)) return;
  const secret = doc.push?.secret || randomToken();
  await db.update(KEY(user.id), (x) => { x.push = { ...(x.push || {}), topic, secret, askedAt: now }; return x; }, {});
  const r = await tfetch(HUB, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
    'hub.mode': 'subscribe', 'hub.topic': topic, 'hub.callback': `${config.appUrl}/webhooks/youtube/${user.id}`, 'hub.secret': secret, 'hub.lease_seconds': '864000', 'hub.verify': 'async',
  }) });
  if (!r.ok) throw new Error(`YouTube push subscription failed (HTTP ${r.status})`);
}
/** Google confirms a subscription we asked for. → the challenge to echo, or null. */
export async function confirmPush(uid, q) {
  const D = await db.get(KEY(uid));
  const challenge = String(q['hub.challenge'] || '');
  if (!D?.push || q['hub.mode'] !== 'subscribe' || q['hub.topic'] !== D.push.topic || !/^[\w.~-]{1,300}$/.test(challenge)) return null;
  if (Date.now() - (D.push.askedAt || 0) > 24 * 60 * MIN) return null;
  await db.update(KEY(uid), (x) => { x.push.leaseUntil = Date.now() + Math.min(864_000, Number(q['hub.lease_seconds']) || 432_000) * 1000; return x; }, D);
  return challenge;
}
/** A push arrived. The HMAC proves it answers our own subscription. */
export async function receivePush(uid, signature, raw) {
  const [user, D] = [await getUser(uid), await db.get(KEY(uid))];
  if (!user || !D?.push?.secret) return 404;
  const m = /^sha(1|256)=([0-9a-f]+)$/i.exec(String(signature || ''));
  if (!m || !safeEqual(crypto.createHmac(`sha${m[1]}`, D.push.secret).update(raw).digest('hex'), m[2].toLowerCase())) return 202; // the spec: ignore, but answer 2xx
  if (!user.discord?.enabled || !linked(user)) return 204;
  const ids = [...new Set([...raw.toString('utf8').matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((x) => x[1]))].slice(0, 5);
  const known = new Set((D.done || []).filter((x) => x.state === 'sent').map((x) => x.k.split('@')[0]));
  const fresh = ids.filter((id) => !known.has(`yt:${id}`));
  if (fresh.length) await handleVideos(user, fresh, 'YouTube push');
  return 204;
}

// ── Scheduler (an outside service calls GET /api/cron/discord every minute) ──
let list = { at: 0, uids: [] };
/** Runs the checks nobody else is doing. Kept cheap: usually one Redis command and one YouTube unit per streamer. */
export async function cron() {
  const now = Date.now();
  if (now - list.at > 5 * MIN) list = { at: now, uids: (await db.get('system/discord'))?.uids || [] };
  const out = { checked: 0 };
  for (const uid of list.uids.slice(0, 20)) {
    const [u, D0, lastDoc] = await db.mget([`user/${uid}`, KEY(uid), 'cron/discord']);
    const user = normalizeAccounts(u);
    if (!user?.discord?.enabled || !linked(user)) continue;
    const D = D0 || {};
    const last = lastDoc?.[uid] || {};
    const due = (k, ms) => now - (last[k] || 0) >= ms - 5000;
    out.checked += 1;
    if (now > (last.quotaUntil || 0)) {
      const r = await checkLive(user, 'scheduler', { kick: due('kick', 5 * MIN) });
      if (r.error) out.error = r.error;
      if (r.quota) last.quotaUntil = now + 15 * MIN;
    }
    const slow = due('slow', 10 * MIN);
    if (slow) {
      try {
        await ensurePush(user, D);
        if (now > (last.quotaUntil || 0)) {
          const known = new Set((D.done || []).filter((x) => x.state === 'sent' || x.state === 'skipped').map((x) => x.k.split('@')[0]));
          const up = await uploadIds(await ytToken(user), ytAcc(user).channelId, last.uploads);
          last.uploads = up.playlist;
          const fresh = up.items.filter((x) => x.published >= user.discord.since && !known.has(`yt:${x.id}`)).map((x) => x.id);
          if (fresh.length) await handleVideos(user, fresh, 'scheduler');
        }
      } catch (e) { out.error = e.message; }
    }
    if (slow || due('kick', 5 * MIN) || last.quotaUntil > now) {
      await db.set('cron/discord', { ...(lastDoc || {}), [uid]: { ...last, at: now, ...(slow ? { slow: now } : {}), ...(due('kick', 5 * MIN) ? { kick: now } : {}) } });
    }
  }
  return out;
}
/** Remember who uses announcements, so the scheduler doesn't have to look through all users. */
export async function registerDiscord(uid, on) {
  await db.update('system/discord', (S) => {
    const has = (S.uids || []).includes(uid);
    if (has === on) return undefined;
    S.uids = on ? [...(S.uids || []), uid] : S.uids.filter((x) => x !== uid);
    return S;
  }, { uids: [] });
  list.at = 0;
}

// ── Dashboard actions ──
export async function discordStatus(user0) {
  let user = user0;
  let error = null;
  let channels = { list: [], others: [] };
  try { user = await linkOwner(user0); channels = await channelsOf(user, { fresh: true }); } catch (e) { error = e.message; }
  const [D, cronDoc] = await Promise.all([db.get(KEY(user.id)), db.get('cron/discord')]);
  return {
    settings: discordSettings(user), pings: PINGS, defaults: TEXT, server: linked(user) ? { name: user.discord.guildName || 'Discord server', auto: isOwner(user) } : null,
    canInvite: !!config.discord.clientSecret, error, channels: channels.list, others: channels.others, youtube: !!ytAcc(user), kick: !!kickAcc(user),
    push: { on: (D?.push?.leaseUntil || 0) > Date.now(), possible: publicUrl() }, obsAt: D?.obsAt || null,
    cron: { configured: !!config.cronSecret, lastAt: cronDoc?.[user.id]?.at || null }, history: (D?.history || []).slice(0, 20),
  };
}
const SAMPLE = {
  live: { title: 'Test stream: Steal an Egg with viewers', path: '/live' }, video: { title: 'Test video title', path: '/videos' }, short: { title: 'Test Short title #shorts', path: '/shorts' }, kick: { title: 'Test Kick stream' },
};
/** A test looks exactly like the real thing (ping included), marked TEST. Not recorded as an announcement. */
export async function sendTest(user, type) {
  if (!TYPES.includes(type)) throw bad('Unknown type');
  if (!linked(user)) throw bad('Add OmniChat to your Discord server first');
  const s = discordSettings(user);
  const list = await targets(user, type);
  if (!list.length) throw bad(`No channel for ${type === 'kick' ? 'Kick' : 'YouTube'} yet: add the bot to a channel`);
  const acc = type === 'kick' ? kickAcc(user) : ytAcc(user);
  const url = !acc ? null : type === 'kick' ? `https://kick.com/${encodeURIComponent(acc.channelSlug)}` : `https://www.youtube.com/channel/${acc.channelId}${SAMPLE[type]?.path || ''}`;
  const m = buildMessage(s, { type, title: SAMPLE[type]?.title, text: 'This is a test post.', url, name: acc?.channelName || user.name, avatar: acc?.avatar, start: Date.now() }, { test: true });
  for (const c of list) await send(c.id, m);
  return { channels: list.map((c) => c.name) };
}
/** "Go live now": ask the platform first; when it does not know the stream yet, post the channel's live link. */
export async function goLiveNow(user, platform) {
  const type = platform === 'kick' ? 'kick' : 'live';
  const acc = platform === 'kick' ? kickAcc(user) : ytAcc(user);
  if (!acc) throw bad(`Connect ${platform === 'kick' ? 'Kick' : 'YouTube'} first`);
  let ev;
  try {
    if (platform === 'kick') { const k = await kickChannel(user.id, acc); if (k?.live) ev = kickLive(user, k, 'button'); } else {
      const b = (await activeBroadcasts(await ytToken(user))).find((x) => x.privacy === 'public');
      if (b) ev = ytLive(user, b, 'button');
    }
  } catch { /* the plain link still works */ }
  ev ||= { type, key: `${type}:manual:${Math.round(Date.now() / (5 * MIN))}`, start: Date.now(), title: 'Live now', name: acc.channelName, avatar: acc.avatar, source: 'button',
    url: platform === 'kick' ? `https://kick.com/${encodeURIComponent(acc.channelSlug)}` : `https://www.youtube.com/channel/${acc.channelId}/live` };
  const r = await announce(user, { ...ev, manual: true });
  if (r === 'nochannel') throw bad(NO_CHANNEL);
  return r;
}
export async function sendPost(user, { text, url }, file) {
  const t = clean(text, 1800);
  if (!t && !file) throw bad('Write something or add a picture');
  if (url && !httpsOnly(url)) throw bad('The link must start with https://');
  if (!discordSettings(user).types.post.on) throw bad('Posts are switched off');
  // the same text twice within 2 minutes = a double click
  const key = `post:${sha256(`${t}|${url || ''}|${file?.buf.length || 0}`).slice(0, 16)}:${Math.floor(Date.now() / (2 * MIN))}`;
  const r = await announce(user, { type: 'post', key, text: t, title: t.slice(0, 80), url, start: Date.now(), source: 'button', manual: true }, { file });
  if (r === 'nochannel') throw bad(NO_CHANNEL);
  return r;
}

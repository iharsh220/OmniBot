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
import fs from 'node:fs';
import * as db from './store.js';
import { config, tfetch } from './config.js';
import { dapi, botId, botGuilds, guildChannels, guildRoles, plain, has, INVITE_PERMISSIONS } from './discord-api.js';
import { decrypt, encrypt, randomToken, sha256, safeEqual } from './crypto.js';
import { getAccessToken, getUser, updateUser, listAccounts, normalizeAccounts } from './auth.js';
import { addLogs } from './feed.js';
import { record, issue } from './audit.js';
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
const BUTTON = { live: ['Watch live', '▶️'], video: ['Watch video', '▶️'], short: ['Watch Short', '▶️'], post: ['Open link', '🔗'], kick: ['Watch on Kick', '▶️'] };
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
  return {
    enabled: !!s.enabled,
    since: s.since || 0,
    types: Object.fromEntries(TYPES.map((t) => {
      const cur = s.types?.[t] || {};
      return [t, { on: true, ping: 'both', text: TEXT[t], ...cur, roles: Array.isArray(cur.roles) ? cur.roles : [] }];
    })),
  };
}
/** → the new `user.discord` (the server link itself is never taken from the request). */
export async function validateDiscord(b, user) {
  if (!linked(user)) throw bad('Add OmniChat to your Discord server first');
  const cur = discordSettings(user);
  const next = { ...(user.discord || {}), ...structuredClone(cur), modes: { ...(user.discord.modes || {}) } };
  if (b.enabled !== undefined) next.enabled = !!b.enabled;
  const needsRoles = TYPES.some((t) => b.types?.[t]?.roles !== undefined);
  const knownRoles = needsRoles ? new Set((await guildRoles(user.discord.guildId)).map((r) => r.id)) : null;
  for (const t of TYPES) {
    const x = b.types?.[t];
    if (!x || typeof x !== 'object') continue;
    if (x.on !== undefined) next.types[t].on = !!x.on;
    if (x.ping !== undefined) { if (!PINGS.includes(x.ping)) throw bad('Unknown ping'); next.types[t].ping = x.ping; }
    if (x.roles !== undefined) {
      if (!Array.isArray(x.roles)) throw bad('Invalid roles list');
      const ids = [...new Set(x.roles.map((id) => String(id)))].slice(0, 25);
      for (const id of ids) if (!knownRoles.has(id)) throw bad('That tag/role is not in your server');
      next.types[t].roles = ids;
    }
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

// ── The message ──
// Discord "Components V2" card: ping line, animated banner, title + picture of the streamer, stream picture, facts, buttons.
const fill = (text, ev) => text.replace(/\{(name|title|url)\}/g, (_, k) => (k === 'url' ? clean(ev[k], 300) : plainText(ev[k], 200)));
const httpsOnly = (u) => (/^https:\/\/[^\s<>"]+$/.test(String(u || '')) ? String(u).slice(0, 500) : null);
/** Names and titles come from outside: no line breaks, no markdown, no mentions. */
const plainText = (v, n) => clean(v, n).replace(/\s+/g, ' ').replace(/([\\`*_~|[\]])/g, '\\$1').replace(/@/g, '@\u200b');
const num = (n) => Number(n).toLocaleString('en-US');
const length = (ms) => { const m = Math.max(1, Math.round(ms / MIN)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const bigAvatar = (u) => httpsOnly(String(u || '').replace(/=s\d+(?=-)/, '=s240'));
function mentionLine(t) {
  const parts = [];
  if (t.ping === 'both' || t.ping === 'everyone') parts.push('@everyone');
  if (t.ping === 'both' || t.ping === 'here') parts.push('@here');
  for (const id of t.roles || []) if (/^\d{15,25}$/.test(id)) parts.push(`<@&${id}>`);
  return parts.join(' ');
}
function allowedMentions(t) {
  const roles = (t.roles || []).filter((id) => /^\d{15,25}$/.test(id)).slice(0, 25);
  return {
    parse: t.ping && t.ping !== 'none' ? ['everyone'] : [],
    ...(roles.length ? { roles } : {}),
  };
}

const publicUrl = () => /^https:\/\//.test(config.appUrl) && !/localhost|127\.0\.0\.1/.test(config.appUrl);
/** Banner from our own site; on localhost Discord could not load it, so it is attached to the message instead. */
function banner(name) {
  if (publicUrl()) return { url: `${config.appUrl}/discord/${name}` };
  try { return { url: `attachment://${name}`, file: { name, type: name.endsWith('gif') ? 'image/gif' : 'image/jpeg', buf: fs.readFileSync(new URL(`../public/discord/${name}`, import.meta.url)) } }; } catch { return null; }
}
const text = (content) => ({ type: 10, content });
const gallery = (url, description) => ({ type: 12, items: [{ media: { url }, description }] });
const linkButton = (label, url, emoji) => ({ type: 2, style: 5, label, url, ...(emoji ? { emoji: { name: emoji } } : {}) });

/** → { payload, files } */
export function buildCard(s, ev, { test = false, file } = {}) {
  const t = s.types[ev.type];
  const url = httpsOnly(ev.url);
  const image = httpsOnly(ev.image);
  const avatar = bigAvatar(ev.avatar);
  const name = plainText(ev.name, 80);
  const post = ev.type === 'post';
  const ended = !!ev.endedAt;
  const head = [test ? '`TEST`' : '', mentionLine(t), post ? '' : fill(t.text, ev)].filter(Boolean).join(post ? ' ' : '\n').slice(0, 900);
  const ban = post ? null : banner(ended ? 'ended.jpg' : `${ev.type}.gif`);
  const files = [];
  if (ban?.file) files.push(ban.file);
  if (file) files.push(file);

  const title = plainText(ev.title, 200) || LABEL[ev.type];
  const main = post ? `### ${name || 'OmniChat'}\n${clean(ev.text, 1800)}` : `## ${url ? `[${title}](${url})` : title}\n${name ? `**${name}** · ` : ''}${LABEL[ev.type]}`;
  const facts = [];
  if (ev.game) facts.push(`🎮 **${plainText(ev.game, 60)}**`);
  if (ended) {
    facts.push(`⏱️ **${length(ev.endedAt - ev.start)}** live`);
    if (ev.peak > 0) facts.push(`🔥 Peak **${num(ev.peak)}** viewers`);
  } else if (isLive(ev.type)) {
    if (ev.viewers > 0) facts.push(`👀 **${num(ev.viewers)}** watching`);
    facts.push(`⏱️ Started <t:${Math.floor((ev.start || Date.now()) / 1000)}:R>`);
  }
  const buttons = [];
  if (url) buttons.push(ended ? linkButton(ev.type === 'live' ? 'Watch replay' : 'Open Kick', url, '⏪') : linkButton(BUTTON[ev.type][0], url, BUTTON[ev.type][1]));
  for (const b of (post ? [] : ev.more || []).slice(0, 3)) if (httpsOnly(b.url)) buttons.push(linkButton(b.label, b.url, b.emoji));

  const inside = [
    ban ? gallery(ban.url, ended ? 'Stream ended' : LABEL[ev.type]) : null,
    avatar ? { type: 9, components: [text(main)], accessory: { type: 11, media: { url: avatar }, description: clean(ev.name, 80) || undefined } } : text(main),
    image ? gallery(image, clean(ev.title, 200) || undefined) : null,
    file ? gallery(`attachment://${file.name}`) : null,
    facts.length ? text(facts.join('  ·  ')) : null,
    buttons.length ? { type: 14, divider: true, spacing: 1 } : null,
    buttons.length ? { type: 1, components: buttons } : null,
    post ? null : text(`-# ${ended ? 'Stream ended' : 'OmniChat'} · <t:${Math.floor((ended ? ev.endedAt : ev.start || Date.now()) / 1000)}:f>`),
  ].filter(Boolean);
  return {
    files,
    payload: {
      flags: 1 << 15, // Components V2
      components: [...(head ? [text(head)] : []), { type: 17, accent_color: ended ? 0x6b7280 : COLOR[ev.type], components: inside }],
      // only these mentions can ever ping, whatever a title or text contains
      allowed_mentions: allowedMentions(t),
    },
  };
}
/** Plain embed: only used when Discord refuses the card, so an announcement is never lost over its looks. */
export function buildClassic(s, ev, { test = false } = {}) {
  const t = s.types[ev.type];
  const url = httpsOnly(ev.url);
  const image = httpsOnly(ev.image);
  return {
    content: [test ? '`TEST`' : '', mentionLine(t), ev.type === 'post' ? clean(ev.text, 1800) : fill(t.text, ev)].filter(Boolean).join(ev.type === 'post' ? '\n' : ' ').slice(0, 2000),
    allowed_mentions: allowedMentions(t),
    ...(ev.type === 'post' ? {} : { embeds: [{
      title: clean(ev.title, 250) || LABEL[ev.type], url: url || undefined, color: COLOR[ev.type], author: ev.name ? { name: clean(ev.name, 100), icon_url: httpsOnly(ev.avatar) || undefined } : undefined,
      description: ev.game ? `Playing **${plainText(ev.game, 80)}**` : undefined, image: image ? { url: image } : undefined, footer: { text: `OmniChat • ${LABEL[ev.type]}` }, timestamp: new Date(ev.start || Date.now()).toISOString(),
    }] }),
    ...(url ? { components: [{ type: 1, components: [linkButton(BUTTON[ev.type][0], url)] }] } : {}),
  };
}
async function call(method, path, payload, files) {
  if (!files?.length) return dapi(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.buf], { type: f.type }), f.name));
  return dapi(path, { method, body: form });
}
async function send(channel, s, ev, { nonce, file, test } = {}) {
  // enforce_nonce: if our first try did arrive, Discord returns that message instead of posting a second one
  const once = nonce ? { nonce, enforce_nonce: true } : {};
  const card = buildCard(s, ev, { test, file });
  try { return await call('POST', `/channels/${channel}/messages`, { ...card.payload, ...once }, card.files); } catch (e) {
    if (e.discord !== 400) throw e;
    console.warn('[discord] card refused, sending a plain embed:', e.message);
    return call('POST', `/channels/${channel}/messages`, { ...buildClassic(s, ev, { test }), ...once }, file ? [file] : []);
  }
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
const cardOf = (ev) => ({ type: ev.type, title: clean(ev.title, 200), url: ev.url, image: ev.image || null, game: ev.game || null, name: ev.name, avatar: ev.avatar, start: ev.start, more: ev.more || [], viewers: ev.viewers || 0, peak: ev.viewers || 0, endedAt: 0 });
async function finish(uid, ev, result) {
  await db.update(KEY(uid), (D) => {
    const now = Date.now();
    const x = (D.done || []).find((d) => d.k === ev.key);
    if (x) Object.assign(x, { state: result.error ? 'failed' : 'sent', at: now, ...(result.id && isLive(ev.type) ? { mid: result.id, ev: cardOf(ev) } : {}) });
    // only the last few live cards are ever edited again
    (D.done || []).filter((d) => d.ev).slice(0, -8).forEach((d) => { delete d.ev; delete d.mid; });
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
  ev = { ...ev, name: ev.name || user.name, avatar: ev.avatar || user.avatar, more: moreLinks(user, ev.type) };
  const postIn = async (c) => {
    const one = { ...ev, key: `${ev.key}@${c.id}`, ch: c.id, chName: c.name };
    if (!(await claim(user.id, one))) return 'already';
    let result;
    try {
      result = { id: (await send(c.id, s, ev, { nonce: sha256(`${user.id}|${one.key}`).slice(0, 25), file })).id };
    } catch (e) { result = { error: `#${c.name}: ${e.message}${c.missing.length ? ` (missing: ${c.missing.join(', ')})` : ''}` }; }
    await finish(user.id, one, result);
    await addLogs(user.id, [result.error
      ? { level: 'error', source: 'discord', message: `${LABEL[ev.type]} announcement failed in ${result.error}` }
      : { level: 'info', source: 'discord', message: `Announced in #${c.name}: ${LABEL[ev.type]}${ev.title ? ` "${clean(ev.title, 80)}"` : ''} (${ev.source})` }]);
    await record(null, { uid: user.id, kind: 'discord', action: result.error ? 'Discord announcement failed' : 'Announced on Discord', ok: !result.error, detail: `${LABEL[ev.type]} in #${c.name} (${ev.source})${result.error ? ` — ${result.error}` : ''}` });
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
/** Second and third button: subscribe, and the streamer's other platform. */
function moreLinks(user, type) {
  const y = ytAcc(user);
  const k = kickAcc(user);
  const kickUrl = k?.channelSlug ? `https://kick.com/${encodeURIComponent(k.channelSlug)}` : null;
  if (type === 'kick') return y ? [{ label: 'YouTube', emoji: '🔴', url: `https://www.youtube.com/channel/${y.channelId}?sub_confirmation=1` }] : [];
  return [...(y ? [{ label: 'Subscribe', emoji: '🔔', url: `https://www.youtube.com/channel/${y.channelId}?sub_confirmation=1` }] : []), ...(type === 'live' && kickUrl ? [{ label: 'Kick', emoji: '🟢', url: kickUrl }] : [])];
}
const ytLive = (user, b, source) => ({
  type: 'live', key: `yt:${b.id}`, start: b.start || Date.now(), title: b.title, url: `https://www.youtube.com/watch?v=${b.id}`, image: b.image,
  name: ytAcc(user).channelName, avatar: ytAcc(user).avatar, viewers: b.viewers, source,
});
const kickLive = (user, k, source) => {
  const acc = kickAcc(user);
  const start = k.start || Date.now();
  return { type: 'kick', key: `kick:${Math.round(start / MIN)}`, start, title: k.title, url: `https://kick.com/${encodeURIComponent(acc.channelSlug)}`, image: k.image, game: k.game, viewers: k.viewers, name: user.name || acc.channelName, avatar: acc.avatar, source };
};

/** Kick creates the stream picture only a few minutes after the start; until then its address answers 403. */
async function usable(url) {
  if (!httpsOnly(url)) return null;
  try {
    const r = await tfetch(url, {}, 1500);
    r.body?.cancel().catch(() => {});
    return r.ok && /^image\//.test(r.headers.get('content-type') || '') ? url : null;
  } catch { return null; }
}
async function kickInfo(user) {
  const k = await kickChannel(user.id, kickAcc(user));
  return k ? { ...k, image: k.live ? await usable(k.image) : null } : k;
}

// ── Live cards keep themselves up to date: picture, title, viewers, and a short report at the end ──
const openCards = (D, type) => (D?.done || []).filter((x) => x.type === type && x.state === 'sent' && x.mid && x.ev && Date.now() - x.at < 18 * 60 * MIN);
/** info: { live: true, title, image, game, viewers } | { live: false }. Returns whether every open card has its picture. */
export async function updateCards(user, type, info, D0) {
  const D = D0 || (await db.get(KEY(user.id)));
  const now = Date.now();
  const s = discordSettings(user);
  const newest = new Map();
  for (const x of openCards(D, type)) newest.set(x.ch, x); // the list is oldest first
  const changed = new Map();
  for (const x of newest.values()) {
    const ev = { ...x.ev };
    if (info.live) {
      if (ev.endedAt && now - ev.endedAt > 20 * MIN) continue; // an older stream
      ev.endedAt = 0; // reconnected after a drop
      ev.title = clean(info.title, 200) || ev.title;
      ev.game = info.game || ev.game;
      ev.image = info.image || ev.image;
      if (info.viewers != null) { ev.viewers = info.viewers; ev.peak = Math.max(ev.peak || 0, info.viewers); }
    } else {
      if (ev.endedAt) continue;
      ev.endedAt = now;
    }
    const sig = JSON.stringify([ev.title, ev.game, ev.image, ev.viewers, ev.endedAt]);
    if (sig === x.sig) continue;
    try {
      const card = buildCard(s, ev);
      await call('PATCH', `/channels/${x.ch}/messages/${x.mid}`, card.payload, card.files); // an edit never pings again
      changed.set(x.k, { ev, sig, upd: now });
    } catch (e) {
      // deleted by hand or not editable any more → leave it alone from now on
      if (e.discord === 404 || e.discord === 403 || e.discord === 400) changed.set(x.k, null);
      else console.warn('[discord] card update', e.message);
    }
  }
  if (changed.size) {
    await db.update(KEY(user.id), (d) => {
      for (const x of d.done || []) if (changed.has(x.k)) { const c = changed.get(x.k); if (c) Object.assign(x, c); else { delete x.ev; delete x.mid; } }
      return d;
    }, {});
  }
  return [...newest.values()].every((x) => (changed.get(x.k)?.ev || x.ev).image);
}

/** engine.tick: the overlay/dashboard polling found a live stream. Remembers it in the state, so it costs nothing afterwards. */
export async function announceFromTick(user, states) {
  if (!user.discord?.enabled || !linked(user)) return;
  const now = Date.now();
  const one = async (st, type, id, make, info) => {
    if (!st) return;
    if (st.live && id && st._announced !== id) {
      const r = await safely(async () => announce(user, await make()), user.id);
      if (r !== 'failed') { st._announced = id; st._card = { open: r === 'sent' || r === 'already', at: now, image: false }; }
    } else if (st.live && id && st._card?.open && now - st._card.at > (st._card.image ? 3 * MIN : 45_000)) {
      const image = await safely(async () => updateCards(user, type, { live: true, ...(await info()) }), user.id);
      st._card = { open: true, at: now, image: image === true };
    } else if (!st.live && st._card?.open) {
      const r = await safely(() => updateCards(user, type, { live: false }), user.id);
      if (r !== 'failed') st._card = { open: false };
    }
  };
  const y = states.youtube;
  await one(y, 'live', y?._official && y._privacy === 'public' ? y._videoId : null,
    () => ytLive(user, { id: y._videoId, title: y.title, start: y._startedAt, image: y._image, viewers: y.viewers }, 'polling'), () => ({ title: y.title, image: y._image, viewers: y.viewers }));
  const k = states.kick;
  await one(k, 'kick', k?._startedAt || null,
    async () => kickLive(user, { title: k.title, start: k._startedAt, image: await usable(k._image), game: k.game, viewers: k.viewers }, 'polling'), async () => ({ title: k.title, image: k._card?.image ? k._image : await usable(k._image), game: k.game, viewers: k.viewers }));
}
/** Kick told us directly. The picture / game are a bonus: a slow API must not delay the ping (the card gets them later). */
export async function announceKickWebhook(user, payload) {
  if (!user.discord?.enabled || !linked(user) || !kickAcc(user)) return;
  await safely(async () => {
    if (!payload?.is_live) return updateCards(user, 'kick', { live: false });
    const info = await Promise.race([kickInfo(user).catch(() => null), new Promise((r) => setTimeout(r, 1500, null))]);
    return announce(user, kickLive(user, { title: payload.title || info?.title, start: Date.parse(payload.started_at) || Date.now(), image: info?.image, game: info?.game, viewers: info?.viewers }, 'Kick webhook'));
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
      const list = (await activeBroadcasts(await ytToken(user), user.id)).filter((b) => b.privacy === 'public');
      out.youtube = list.length > 0;
      if (list[0]) out.yt = { title: list[0].title, image: list[0].image };
      for (const b of list) await announce(user, ytLive(user, b, source));
    })().catch((e) => { out.error = `YouTube: ${e.message}`; out.quota = e.reason === 'quotaExceeded'; }),
    (async () => {
      if (!kick || !kickAcc(user)) return;
      const k = await kickInfo(user);
      out.kick = !!k?.live;
      if (k?.live) out.kk = { title: k.title, image: k.image, game: k.game, viewers: k.viewers };
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
  let begun = false;
  await db.update(KEY(user.id), (D) => {
    go = false;
    active = false;
    begun = false;
    const now = Date.now();
    const B = D.burst || { until: 0, starts: [] };
    const started = event === 'start' && now > B.until;
    if (started) {
      B.starts = B.starts.filter((t) => t > now - 60 * MIN);
      if (B.starts.length >= 8) return undefined;
      B.starts.push(now);
      B.until = now + 3 * MIN;
      D.obsAt = now;
      begun = true;
    }
    active = now < B.until;
    D.burst = B;
    if (!active || now - (D.checkAt || 0) < 3500) return started ? D : undefined; // several overlays ask at once → one check
    D.checkAt = now;
    go = true;
    return D;
  }, {});
  if (begun) await record(null, { uid: user.id, kind: 'discord', action: 'Streaming app started', detail: 'Start signal from an overlay' });
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
  for (const v of await videosByIds(await ytToken(user), ids, user.id)) {
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
      // a fresh Kick card without its picture is worth looking at every minute
      const kickCard = openCards(D, 'kick').at(-1);
      const r = await checkLive(user, 'scheduler', { kick: due('kick', 5 * MIN) || !!(kickCard && !kickCard.ev.endedAt && !kickCard.ev.image && now - kickCard.at < 20 * MIN) });
      for (const [type, live, info] of [['live', r.youtube, r.yt], ['kick', r.kick, r.kk]]) {
        const x = openCards(D, type).at(-1);
        if (!x || live === null || now - x.at < 45_000) continue;
        if (live ? now - (x.upd || x.at) > (x.ev.image ? 5 * MIN : 45_000) : !x.ev.endedAt && now - x.at > 3 * MIN) await safely(() => updateCards(user, type, live ? { live: true, ...info } : { live: false }, D), uid);
      }
      if (r.error) { out.error = r.error; await issue(null, { uid, level: 'warn', kind: 'discord', message: `Live check failed: ${r.error}`, dedupeMs: 60 * MIN }); }
      if (r.quota) last.quotaUntil = now + 15 * MIN;
    }
    const slow = due('slow', 10 * MIN);
    if (slow) {
      try {
        await ensurePush(user, D);
        if (now > (last.quotaUntil || 0)) {
          const known = new Set((D.done || []).filter((x) => x.state === 'sent' || x.state === 'skipped').map((x) => x.k.split('@')[0]));
          const up = await uploadIds(await ytToken(user), ytAcc(user).channelId, last.uploads, user.id);
          last.uploads = up.playlist;
          const fresh = up.items.filter((x) => x.published >= user.discord.since && !known.has(`yt:${x.id}`)).map((x) => x.id);
          if (fresh.length) await handleVideos(user, fresh, 'scheduler');
        }
      } catch (e) { out.error = e.message; await issue(null, { uid, level: 'warn', kind: 'discord', message: `Upload check failed: ${e.message}`, dedupeMs: 60 * MIN }); }
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
  if (!on) await db.update('cron/discord', (C) => { if (!C[uid]) return undefined; delete C[uid]; return C; }, {}); // nothing about this streamer stays behind
  list.at = 0;
}

// ── Admin panel ──
const brief = (D) => ({
  sent: (D?.history || []).filter((x) => x.ok).length, failed: (D?.history || []).filter((x) => !x.ok).length, lastAt: D?.history?.[0]?.ts || null,
  obsAt: D?.obsAt || null, push: (D?.push?.leaseUntil || 0) > Date.now(),
});
/** Everything about announcements, for the OmniChat Bot account. `users` = admin user rows (id, name, avatar, discord). */
export async function adminDiscord(users) {
  const using = users.filter((u) => u.discord);
  const [docs, cronDoc, servers] = await Promise.all([
    db.mget(using.map((u) => KEY(u.id))), db.get('cron/discord'),
    config.discord.botToken ? botGuilds().then((l) => l.map((g) => ({ id: g.id, name: clean(g.name, 100) }))).catch((e) => ({ error: e.message })) : { error: 'DISCORD_BOT_TOKEN is not set' },
  ]);
  const owner = new Map();
  for (const u of using) owner.set(u.discord.guildId, [...(owner.get(u.discord.guildId) || []), u.name]);
  return {
    setup: { bot: !!config.discord.botToken && !servers.error, error: servers.error || null, invite: !!config.discord.clientSecret, cron: !!config.cronSecret, cronAt: Math.max(0, ...Object.values(cronDoc || {}).map((x) => x?.at || 0)) || null },
    servers: servers.error ? [] : servers.slice(0, 200).map((g) => ({ name: g.name, linkedTo: owner.get(g.id) || [] })),
    streamers: using.map((u, i) => ({ id: u.id, name: u.name, avatar: u.avatar, server: u.discord.server, enabled: u.discord.enabled, cronAt: cronDoc?.[u.id]?.at || null, ...brief(docs[i]) })),
    history: using.flatMap((u, i) => (docs[i]?.history || []).map((x) => ({ ...x, uid: u.id, name: u.name, avatar: u.avatar }))).sort((a, b) => b.ts - a.ts).slice(0, 200),
  };
}
export async function userDiscord(user) {
  if (!user?.discord?.guildId) return null;
  const D = await db.get(KEY(user.id));
  const s = discordSettings(user);
  const tagSummary = (t) => {
    const x = s.types[t];
    if (!x.on) return 'off';
    const rc = x.roles?.length || 0;
    if (!rc) return x.ping;
    return x.ping === 'none' ? `${rc} role${rc > 1 ? 's' : ''}` : `${x.ping} + ${rc} role${rc > 1 ? 's' : ''}`;
  };
  return { server: user.discord.guildName || 'Discord server', enabled: s.enabled, types: Object.fromEntries(TYPES.map((t) => [t, tagSummary(t)])), ...brief(D), history: (D?.history || []).slice(0, 40) };
}

// ── Dashboard actions ──
export async function discordStatus(user0) {
  let user = user0;
  let error = null;
  let channels = { list: [], others: [] };
  let roles = [];
  try {
    user = await linkOwner(user0);
    channels = await channelsOf(user, { fresh: true });
    if (linked(user)) roles = await guildRoles(user.discord.guildId);
  } catch (e) { error = e.message; }
  const [D, cronDoc] = await Promise.all([db.get(KEY(user.id)), db.get('cron/discord')]);
  return {
    settings: discordSettings(user), pings: PINGS, roles, defaults: TEXT, server: linked(user) ? { name: user.discord.guildName || 'Discord server', auto: isOwner(user) } : null,
    canInvite: !!config.discord.clientSecret, error, channels: channels.list, others: channels.others, youtube: !!ytAcc(user), kick: !!kickAcc(user),
    push: { on: (D?.push?.leaseUntil || 0) > Date.now(), possible: publicUrl() }, obsAt: D?.obsAt || null,
    cron: { configured: !!config.cronSecret, lastAt: cronDoc?.[user.id]?.at || null }, history: (D?.history || []).slice(0, 20),
  };
}
const SAMPLE = { live: 'Test stream: Steal an Egg with viewers', video: 'Test video title', short: 'Test Short title', kick: 'Test Kick stream' };
/** A test looks exactly like the real thing (ping included), marked TEST. Not recorded as an announcement. */
export async function sendTest(user, type) {
  if (!TYPES.includes(type)) throw bad('Unknown type');
  if (!linked(user)) throw bad('Add OmniChat to your Discord server first');
  const s = discordSettings(user);
  const channels = await targets(user, type);
  if (!channels.length) throw bad(`No channel for ${type === 'kick' ? 'Kick' : 'YouTube'} yet: add the bot to a channel`);
  const y = ytAcc(user);
  const acc = type === 'kick' ? kickAcc(user) : y;
  // the newest upload's picture, so the test has a real thumbnail
  let image = null;
  try {
    if (y && type !== 'post') {
      const token = await ytToken(user);
      image = (await videosByIds(token, (await uploadIds(token, y.channelId, null, user.id)).items.slice(0, 1).map((x) => x.id), user.id))[0]?.image || null;
    }
  } catch { /* the test works without it */ }
  const url = type === 'post' || !acc ? null : type === 'kick' ? `https://kick.com/${encodeURIComponent(acc.channelSlug)}` : `https://www.youtube.com/channel/${acc.channelId}${{ live: '/live', video: '/videos', short: '/shorts' }[type]}`;
  const ev = { type, title: SAMPLE[type], text: 'This is a test post.', url, image, name: user.name || acc?.channelName, avatar: acc?.avatar || user.avatar, start: Date.now(), more: moreLinks(user, type), ...(type === 'kick' ? { game: 'Roblox' } : {}), ...(isLive(type) ? { viewers: 128 } : {}) };
  for (const c of channels) await send(c.id, s, ev, { test: true });
  return { channels: channels.map((c) => c.name) };
}
/** "Go live now": ask the platform first; when it does not know the stream yet, post the channel's live link. */
export async function goLiveNow(user, platform) {
  const type = platform === 'kick' ? 'kick' : 'live';
  const acc = platform === 'kick' ? kickAcc(user) : ytAcc(user);
  if (!acc) throw bad(`Connect ${platform === 'kick' ? 'Kick' : 'YouTube'} first`);
  let ev;
  try {
    if (platform === 'kick') { const k = await kickChannel(user.id, acc); if (k?.live) ev = kickLive(user, k, 'button'); } else {
      const b = (await activeBroadcasts(await ytToken(user), user.id)).find((x) => x.privacy === 'public');
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

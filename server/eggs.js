// Egg Bot: reads Steal-an-Egg spawn alerts from ONE Discord channel (set by the OmniChat Bot account,
// filled by a notifier bot such as "SenZ V2") into a shared feed, and announces new eggs in the
// YouTube (OmniChat Bot) and Kick (app bot) chat of every streamer who switched the Egg Bot ON.
import { config, tfetch } from './config.js';
import * as db from './store.js';

const DISCORD = 'https://discord.com/api/v10';
const MAX_HISTORY = 150;
const YT_MAX = 200; // YouTube live chat message length limit

// enabled = master ON/OFF · youtube / kick = where to post · commandEnabled = !egghistory
// YouTube messages always come from the shared OmniChat Bot; Kick from the Kick app bot.
export const defaultEggSettings = () => ({ enabled: false, commandEnabled: true, rarities: [], youtube: true, kick: true });
export const eggSettings = (user) => ({ ...defaultEggSettings(), ...(user.egg || {}) });

const stripEmoji = (s) => String(s || '').replace(/<a?:\w+:\d+>/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

/** Parse one Discord message into 0..n eggs. Handles the embed format of "SenZ V2 | Steal An Egg Notifier". */
// Egg picture = the embed thumbnail (a Discord emoji PNG). Only Discord CDN URLs are kept.
const IMG_RE = /^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/[\w./-]+(?:\?[\w=&.-]*)?$/;
function eggImage(e) {
  const u = String(e.thumbnail?.url || e.image?.url || '');
  return IMG_RE.test(u) && u.length < 400 ? u : null;
}

export function parseEggMessage(m) {
  const out = [];
  (m.embeds || []).forEach((e, i) => {
    const title = stripEmoji(e.title);
    const desc = String(e.description || '');
    const field = (label) => {
      const fromDesc = desc.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]+)`, 'i'));
      if (fromDesc) return stripEmoji(fromDesc[1]);
      const f = (e.fields || []).find((x) => stripEmoji(x.name).toLowerCase().startsWith(label.toLowerCase()));
      return f ? stripEmoji(f.value) : null;
    };
    const name = field('Egg');
    if (!name) return;
    const t = desc.match(/<t:(\d+):R>/) || String(e.title || '').match(/<t:(\d+)/);
    out.push({
      id: `${m.id}-${i}`,
      ts: t ? Number(t[1]) * 1000 : Date.parse(m.timestamp) || Date.now(),
      rarity: (title.match(/([A-Za-z]+)\s+Egg\s+Spawned/i) || [])[1] || null,
      name: name.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').slice(0, 60),
      location: field('Location'),
      money: field('Money'),
      speed: field('Recommended Speed'),
      image: eggImage(e),
    });
  });
  if (!out.length && m.content) { // plain-text fallback, e.g. "Egg: Divine"
    const x = stripEmoji(m.content).match(/Egg[:\s-]+([^\n|]+)/i);
    if (x) out.push({ id: `${m.id}-0`, ts: Date.parse(m.timestamp) || Date.now(), rarity: null, name: x[1].trim().slice(0, 60), location: null, money: null, speed: null });
  }
  return out;
}

async function fetchMessages(channelId, afterId, limit, beforeId) {
  const url = new URL(`${DISCORD}/channels/${channelId}/messages`);
  url.searchParams.set('limit', String(limit || (afterId ? 50 : 15)));
  if (afterId) url.searchParams.set('after', afterId);
  if (beforeId) url.searchParams.set('before', beforeId);
  const r = await tfetch(url, { headers: { Authorization: `Bot ${config.discord.botToken}` } });
  if (!r.ok) {
    const msg = {
      401: 'Invalid DISCORD_BOT_TOKEN',
      403: 'The Discord bot cannot read this channel — invite it and allow View Channel + Read Message History',
      404: 'Discord channel not found — check the Channel ID',
      429: 'Discord rate limit — will retry',
    }[r.status];
    throw new Error(msg || `Discord HTTP ${r.status}`);
  }
  const list = await r.json();
  return list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); // oldest → newest
}

export const formatEgg = (e) => {
  const parts = [`🥚 ${e.rarity ? `${e.rarity} Egg` : 'Egg'} spawned: ${e.name}`];
  if (e.location) parts.push(`📍${e.location}`);
  if (e.money) parts.push(`💰${e.money}`);
  if (e.speed) parts.push(`⚡${e.speed}`);
  return parts.join(' | ').slice(0, YT_MAX);
};

function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
/** "!egghistory" reply → chat messages within `max` chars each (YouTube 200, Kick 500). */
export function historyMessages(items, n = 10, max = YT_MAX) {
  const list = items.slice(0, n).map((e) => `${e.name}${e.rarity ? ` (${e.rarity})` : ''} ${ago(e.ts)}`);
  if (!list.length) return ['🥚 No eggs recorded yet.'];
  const msgs = [];
  let cur = `🥚 Last ${list.length} eggs: `;
  for (const item of list) {
    const piece = (cur.endsWith(': ') ? '' : ' · ') + item;
    if ((cur + piece).length > max) { msgs.push(cur); cur = `🥚 …${item}`; } else cur += piece;
  }
  msgs.push(cur);
  return msgs.slice(0, 2);
}

const today = () => new Date().toISOString().slice(0, 10);
const GLOBAL = 'eggs/global';
const blankGlobal = () => ({ channelId: null, lastMessageId: null, items: [], _nextAt: 0, error: null, lastCheckAt: null });

// ── The Discord channel everyone shares (set by the OmniChat Bot account) ──
export async function getEggChannelId() {
  return (await db.get('system/config'))?.eggChannelId || process.env.EGG_DISCORD_CHANNEL_ID || '';
}
export async function setEggChannelId(id) {
  await db.update('system/config', (c) => ({ ...(c || {}), eggChannelId: id }), {});
}

// ── "Last seen" board: one entry per egg name, kept forever (Divine eggs can be days apart) ──
const BACKFILL_PAGES_PER_RUN = 3; // ×100 messages, walking back through the channel history
const BACKFILL_MAX_PAGES = 80; // ~8000 messages
const BACKFILL_MAX_AGE = 45 * 86_400_000; // stop at 45 days back
const MAX_SEEN = 400;
// Rare rarities keep their last spawns as a list (not one per name): "last 5 Divine — which, when".
export const SPAWN_LIST_RARITIES = ['divine'];
const SPAWN_LIST_MAX = 10;
function addRecent(G, eggs) {
  G.recent = G.recent || {};
  for (const e of eggs) {
    const r = String(e?.rarity || '').toLowerCase();
    if (!SPAWN_LIST_RARITIES.includes(r)) continue;
    const list = G.recent[r] || [];
    if (list.some((x) => x.id === e.id)) continue;
    list.push({ id: e.id, name: e.name, rarity: e.rarity, ts: e.ts, location: e.location, money: e.money, speed: e.speed, image: e.image || null });
    G.recent[r] = list.sort((a, b) => b.ts - a.ts).slice(0, SPAWN_LIST_MAX);
  }
}
/** Board data sent to widgets: last-seen per name + the rare spawn lists. */
export const boardList = (feed) => [...Object.values(feed.seen || {}), ...Object.values(feed.recent || {}).flat()];
function addSeen(G, eggs) {
  addRecent(G, eggs);
  G.seen = G.seen || {};
  for (const e of eggs) {
    if (!e?.name) continue;
    const k = e.name.toLowerCase();
    const cur = G.seen[k];
    if (cur && cur.ts >= e.ts) { if (!cur.image && e.image) cur.image = e.image; continue; }
    G.seen[k] = { id: e.id, name: e.name, rarity: e.rarity, ts: e.ts, location: e.location, money: e.money, speed: e.speed, image: e.image || cur?.image || null };
  }
  const keys = Object.keys(G.seen);
  if (keys.length > MAX_SEEN) {
    keys.sort((a, b) => G.seen[b].ts - G.seen[a].ts).slice(MAX_SEEN).forEach((k) => delete G.seen[k]);
  }
}

/** Read new Discord messages into the shared feed — at most once per EGG_POLL_MS for ALL streamers. */
export async function refreshGlobalFeed() {
  const now = Date.now();
  let claimed = false;
  let g = await db.update(GLOBAL, (G) => {
    claimed = false; // may re-run on an etag conflict
    if ((G._nextAt || 0) > now) return undefined;
    G._nextAt = now + config.eggs.pollMs;
    claimed = true;
    return G;
  }, blankGlobal());
  if (!claimed) return { feed: g, logs: [] };

  const logs = [];
  const channelId = await getEggChannelId();
  if (!channelId || !config.discord.botToken) return { feed: g, logs };
  const reset = g.channelId !== channelId;
  let fresh = [];
  let lastId = reset ? null : g.lastMessageId;
  let error = null;
  try {
    const msgs = await fetchMessages(channelId, lastId);
    for (const m of msgs) fresh.push(...parseEggMessage(m));
    if (msgs.length) lastId = msgs[msgs.length - 1].id;
  } catch (e) {
    error = e.message;
    logs.push({ level: 'warn', source: 'eggs', message: e.message });
  }
  // Walk back through older history a few pages per run until the "last seen" board is complete.
  const old = [];
  let bf = g.backfill || { before: null, pages: 0, done: false };
  if (!error && !reset && !bf.done) {
    bf = { ...bf };
    try {
      for (let i = 0; i < BACKFILL_PAGES_PER_RUN && !bf.done; i++) {
        const before = bf.before || g.items[g.items.length - 1]?.id?.split('-')[0] || g.lastMessageId;
        if (!before) { bf.done = true; break; }
        const page = await fetchMessages(channelId, null, 100, before);
        bf.pages += 1;
        if (!page.length) { bf.done = true; break; }
        bf.before = page[0].id; // oldest of this page
        for (const m of page) old.push(...parseEggMessage(m));
        const oldestTs = Date.parse(page[0].timestamp) || 0;
        if (bf.pages >= BACKFILL_MAX_PAGES || Date.now() - oldestTs > BACKFILL_MAX_AGE || page.length < 100) bf.done = true;
      }
    } catch (e) {
      logs.push({ level: 'warn', source: 'eggs', message: `History backfill: ${e.message}` });
    }
  }
  // One-time: feeds saved before egg pictures existed get their images from the last 100 messages.
  const pics = new Map();
  if (!error && !reset && !g.imagesV1 && g.items.some((x) => !('image' in x))) {
    try {
      for (const m of await fetchMessages(channelId, null, 100)) for (const e of parseEggMessage(m)) if (e.image) pics.set(e.id, e.image);
    } catch { /* try again next time */ }
  }
  g = await db.update(GLOBAL, (G) => {
    if (pics.size) {
      G.items = G.items.map((x) => ('image' in x ? x : { ...x, image: pics.get(x.id) || null }));
      G.imagesV1 = true;
    }
    if (reset) { G.items = []; G.channelId = channelId; G.seen = {}; G.recent = {}; G.backfill = null; }
    const have = new Set(G.items.map((x) => x.id));
    G.items = [...fresh.filter((e) => !have.has(e.id)).reverse(), ...G.items].slice(0, MAX_HISTORY); // newest first
    if (!G.seen) addSeen(G, G.items); // first time: start the board from what we already have
    addSeen(G, old);
    addSeen(G, fresh);
    if (!reset && (old.length || bf.pages !== (G.backfill?.pages || 0))) G.backfill = bf;
    if (lastId) G.lastMessageId = lastId;
    G.error = error;
    G.lastCheckAt = Date.now();
    if (error) G._nextAt = Date.now() + 60_000;
    return G;
  }, blankGlobal());
  return { feed: g, logs };
}

export const readFeed = async () => (await db.get(GLOBAL)) || blankGlobal();

/**
 * Per-streamer step (engine tick). Returns chat messages to post: [{ to: 'youtube'|'kick', text }].
 * `targets` = platforms that can be posted to right now (switch ON + live + bot ready).
 * The first run only remembers the newest egg, so a streamer never gets a backlog of old eggs.
 */
export async function eggStep({ uid, user, commands, targets }) {
  const s = eggSettings(user);
  const { feed, logs } = await refreshGlobalFeed();
  const posts = [];
  const doc = (await db.get(`eggs/${uid}`)) || { lastSeenId: null, posted: { day: today(), n: 0 }, lastCmdAt: 0 };
  if (doc.posted?.day !== today()) doc.posted = { day: today(), n: 0 };
  const items = feed.items || [];

  // eggs this streamer hasn't seen yet (items are newest first)
  let fresh = [];
  if (doc.lastSeenId) {
    const i = items.findIndex((e) => e.id === doc.lastSeenId);
    fresh = (i === -1 ? items.slice(0, 5) : items.slice(0, i)).reverse(); // oldest → newest
  }
  const newestId = items[0]?.id || doc.lastSeenId;
  const changed = newestId !== doc.lastSeenId;
  doc.lastSeenId = newestId;

  const wanted = (e) => !s.rarities.length || (e.rarity && s.rarities.includes(e.rarity));
  if (s.enabled) {
    for (const e of fresh.filter(wanted)) {
      if (targets.youtube) posts.push({ to: 'youtube', text: formatEgg(e) });
      if (targets.kick) posts.push({ to: 'kick', text: formatEgg(e) });
    }
  }

  // !egghistory typed in YouTube chat (30 s cooldown)
  if (s.commandEnabled && commands.length && targets.youtube && Date.now() - (doc.lastCmdAt || 0) > 30_000) {
    doc.lastCmdAt = Date.now();
    for (const text of historyMessages(items)) posts.push({ to: 'youtube', text });
    logs.push({ level: 'info', source: 'eggs', message: `!egghistory requested by ${commands[0]} (YouTube)` });
  }

  // YouTube quota guard (Kick has no quota)
  const yt = posts.filter((p) => p.to === 'youtube');
  const room = Math.max(0, Math.min(config.eggs.dailyPostLimit - doc.posted.n, 4));
  const ytAllowed = yt.slice(0, room);
  if (yt.length > ytAllowed.length) logs.push({ level: 'warn', source: 'eggs', message: `Skipped ${yt.length - ytAllowed.length} YouTube message(s) (rate/daily limit)` });
  doc.posted.n += ytAllowed.length;
  if (changed || posts.length || commands.length) await db.set(`eggs/${uid}`, doc);
  return { posts: [...ytAllowed, ...posts.filter((p) => p.to === 'kick').slice(0, 6)], logs, newEggs: fresh };
}

/** !egghistory typed in Kick chat (arrives via webhook). Returns the reply text, or null (cooldown/off). */
export async function kickHistoryReply(uid, user) {
  const s = eggSettings(user);
  if (!s.commandEnabled || !s.kick) return null;
  let ok = false;
  await db.update(`eggs/${uid}`, (doc) => {
    ok = false; // may re-run on an etag conflict
    if (Date.now() - (doc.lastKickCmdAt || 0) < 30_000) return undefined;
    doc.lastKickCmdAt = Date.now();
    ok = true;
    return doc;
  }, { lastSeenId: null, posted: { day: today(), n: 0 } });
  if (!ok) return null;
  return historyMessages((await readFeed()).items, 10, 500)[0];
}

export async function readEggs(uid) {
  const [feed, doc] = await Promise.all([readFeed(), db.get(`eggs/${uid}`)]);
  return { ...feed, posted: doc?.posted || { day: today(), n: 0 } };
}

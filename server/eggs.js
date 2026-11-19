// Egg Bot: reads Steal-an-Egg spawn alerts from the streamer's Discord channel (posted there by a
// notifier bot such as "SenZ V2"), keeps a history, and announces new eggs in YouTube live chat.
import { config, tfetch } from './config.js';
import * as db from './store.js';

const DISCORD = 'https://discord.com/api/v10';
const MAX_HISTORY = 50;
const YT_MAX = 200; // YouTube live chat message length limit

// enabled = master ON/OFF · youtube / kick = where to post · commandEnabled = !egghistory
// botMode: 'shared' = post as the shared OmniChat Bot · 'own' = the streamer's own bot account
export const defaultEggSettings = () => ({ enabled: false, commandEnabled: true, channelId: '', rarities: [], youtube: true, kick: true, botMode: 'shared' });
export const eggSettings = (user) => ({ ...defaultEggSettings(), ...(user.egg || {}) });

const stripEmoji = (s) => String(s || '').replace(/<a?:\w+:\d+>/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

/** Parse one Discord message into 0..n eggs. Handles the embed format of "SenZ V2 | Steal An Egg Notifier". */
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
    });
  });
  if (!out.length && m.content) { // plain-text fallback, e.g. "Egg: Divine"
    const x = stripEmoji(m.content).match(/Egg[:\s-]+([^\n|]+)/i);
    if (x) out.push({ id: `${m.id}-0`, ts: Date.parse(m.timestamp) || Date.now(), rarity: null, name: x[1].trim().slice(0, 60), location: null, money: null, speed: null });
  }
  return out;
}

async function fetchMessages(channelId, afterId) {
  const url = new URL(`${DISCORD}/channels/${channelId}/messages`);
  url.searchParams.set('limit', afterId ? '50' : '15');
  if (afterId) url.searchParams.set('after', afterId);
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

/**
 * Called from the engine tick. Reads new eggs from Discord, stores them, and returns chat
 * messages to post: [{ to: 'youtube'|'kick', text }]. `targets` says which platforms can be
 * posted to right now (setting ON + live + bot permission). YouTube is capped per day (quota).
 */
export async function eggStep({ uid, user, eggState, commands, targets }) {
  const s = eggSettings(user);
  const now = Date.now();
  const posts = [];
  const logs = [];
  const doc = (await db.get(`eggs/${uid}`)) || { lastMessageId: null, items: [], posted: { day: today(), n: 0 }, lastCmdAt: 0 };
  if (doc.posted?.day !== today()) doc.posted = { day: today(), n: 0 };

  // 1) new eggs from Discord
  let fresh = [];
  if (s.channelId && config.discord.botToken && now >= (eggState._nextAt || 0)) {
    eggState._nextAt = now + config.eggs.pollMs;
    try {
      const msgs = await fetchMessages(s.channelId, doc.lastMessageId);
      const firstSync = !doc.lastMessageId;
      for (const m of msgs) fresh.push(...parseEggMessage(m));
      if (msgs.length) doc.lastMessageId = msgs[msgs.length - 1].id;
      const have = new Set(doc.items.map((x) => x.id));
      fresh = fresh.filter((e) => !have.has(e.id));
      doc.items = [...fresh.slice().reverse(), ...doc.items].slice(0, MAX_HISTORY); // newest first
      if (firstSync) { fresh = []; logs.push({ level: 'info', source: 'eggs', message: `Egg Bot connected to Discord channel — ${doc.items.length} recent eggs loaded` }); }
      eggState.error = null;
      eggState.lastCheckAt = now;
    } catch (e) {
      eggState.error = e.message;
      eggState._nextAt = now + 60_000;
      logs.push({ level: 'warn', source: 'eggs', message: e.message });
    }
  }

  // 2) announcements → every enabled platform
  const wanted = (e) => !s.rarities.length || (e.rarity && s.rarities.includes(e.rarity));
  if (s.enabled) {
    for (const e of fresh.filter(wanted)) {
      if (targets.youtube) posts.push({ to: 'youtube', text: formatEgg(e) });
      if (targets.kick) posts.push({ to: 'kick', text: formatEgg(e) });
    }
  }

  // 3) !egghistory typed in YouTube chat (30 s cooldown)
  if (s.commandEnabled && commands.length && targets.youtube && now - (doc.lastCmdAt || 0) > 30_000) {
    doc.lastCmdAt = now;
    for (const text of historyMessages(doc.items)) posts.push({ to: 'youtube', text });
    logs.push({ level: 'info', source: 'eggs', message: `!egghistory requested by ${commands[0]} (YouTube)` });
  }

  // YouTube quota guard (Kick has no quota)
  const yt = posts.filter((p) => p.to === 'youtube');
  const room = Math.max(0, Math.min(config.eggs.dailyPostLimit - doc.posted.n, 4));
  const ytAllowed = yt.slice(0, room);
  if (yt.length > ytAllowed.length) logs.push({ level: 'warn', source: 'eggs', message: `Skipped ${yt.length - ytAllowed.length} YouTube message(s) (rate/daily limit)` });
  doc.posted.n += ytAllowed.length;
  const out = [...ytAllowed, ...posts.filter((p) => p.to === 'kick').slice(0, 6)];
  if (fresh.length || commands.length || eggState.lastCheckAt === now) await db.set(`eggs/${uid}`, doc);
  return { posts: out, logs, newEggs: fresh };
}

/** !egghistory typed in Kick chat (arrives via webhook). Returns the reply text or null (cooldown/off). */
export async function kickHistoryReply(uid, user) {
  const s = eggSettings(user);
  if (!s.commandEnabled || !s.kick) return null;
  let reply = null;
  await db.update(`eggs/${uid}`, (doc) => {
    if (Date.now() - (doc.lastKickCmdAt || 0) < 30_000) return undefined;
    doc.lastKickCmdAt = Date.now();
    reply = historyMessages(doc.items, 10, 500)[0];
    return doc;
  }, { lastMessageId: null, items: [], posted: { day: today(), n: 0 } });
  return reply;
}

export async function readEggs(uid) {
  return (await db.get(`eggs/${uid}`)) || { lastMessageId: null, items: [], posted: { day: today(), n: 0 } };
}

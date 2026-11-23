// Live tools: highlight a chat message on stream, chat polls (!vote), custom commands + timers,
// and the stream summary. Everything is per streamer and runs inside normal requests (serverless).
import * as db from './store.js';
import { pushEvent, readHistory } from './feed.js';

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);
const textOf = (m) => (m.parts || []).map((p) => (p.type === 'emote' ? '' : p.text || '')).join('').trim();
const YT_MAX = 200;
const KICK_MAX = 500;
// YouTube: each bot message costs ~50 quota units, shared by every streamer → keep a daily cap.
const YT_DAILY = Number(process.env.CMD_DAILY_YOUTUBE) || 60;

// ── Highlight: copy a message from the live stream into a "highlight" alert ──
export async function highlightMessage(uid, msgId) {
  const E = (await db.get(`events/${uid}`)) || { items: [] };
  const hit = [...E.items].reverse().find((x) => x.t === 'chat' && x.msg?.id === msgId && x.msg.kind !== 'highlight');
  if (!hit) throw Object.assign(new Error('Message not found (it may be too old). Pick a newer one.'), { status: 404 });
  const m = hit.msg;
  const msg = { ...m, id: `hl-${Date.now()}`, of: m.id, kind: 'highlight', alert: 'highlight', ts: Date.now(), eventText: m.eventText || null };
  await pushEvent(uid, msg);
  return msg;
}
export async function clearHighlight(uid) {
  await pushEvent(uid, { id: `hlx-${Date.now()}`, kind: 'highlight-clear', alert: 'highlight-clear', ts: Date.now(), platform: 'system', author: { name: '' }, parts: [] });
}

// ── Alert numbers: "#3 this stream" per kind (Super Chats, members, subs, follows …) ──
const COUNT_KIND = { superchat: 'superchat', sticker: 'superchat', member: 'member', milestone: 'member', gift: 'gift', sub: 'sub', follow: 'follow', greeting: 'greeting' };
/** Adds `n` (number of that kind this stream) to alert messages. Counts reset after 4 h without alerts. */
export async function numberAlerts(uid, chats) {
  const list = (chats || []).filter((m) => COUNT_KIND[m.alert]);
  if (!list.length) return;
  await db.update(`alertcount/${uid}`, (C) => {
    if (Date.now() - (C.last || 0) > 4 * 3600_000) C.counts = {};
    C.counts = C.counts || {};
    C.seen = C.seen || [];
    for (const m of list) {
      if (C.seen.includes(m.id)) continue;
      const k = COUNT_KIND[m.alert];
      C.counts[k] = (C.counts[k] || 0) + 1;
      m.n = C.counts[k];
      C.seen.push(m.id);
    }
    C.seen = C.seen.slice(-200);
    C.last = Date.now();
    return C;
  }, { counts: {}, last: 0, seen: [] });
}

/** "Send to OBS": a fake alert of one kind, straight into the live stream (marked as a test). */
const TEST = {
  superchat: { kind: 'superchat', amount: '₹500.00', text: 'This is a test Super Chat 🎉' },
  member: { kind: 'member', eventText: 'New member!' },
  gift: { kind: 'member', eventText: 'Gifted 5 memberships' },
  sub: { kind: 'sub', platform: 'kick', eventText: 'Resubscribed (3 months)!' },
  follow: { kind: 'follow', platform: 'kick', eventText: 'Followed!' },
  greeting: { kind: 'greeting', eventText: '👋 said hi' },
  highlight: { kind: 'highlight', text: 'This is how a highlighted chat message looks' },
};
export async function testAlert(uid, type) {
  const t = TEST[type];
  if (!t) throw Object.assign(new Error('Unknown alert type'), { status: 400 });
  const msg = { id: `test-${type}-${Date.now()}`, platform: t.platform || 'youtube', ts: Date.now(), kind: t.kind, alert: type, test: true,
    amount: t.amount, eventText: t.eventText, n: 1, author: { name: 'OmniChat Test', avatar: null }, parts: t.text ? [{ type: 'text', text: t.text }] : [] };
  await pushEvent(uid, msg);
}

// ── Polls: viewers type "!vote 2" (or just "2") in YouTube or Kick chat ──
export const readPoll = async (uid) => (await db.get(`poll/${uid}`)) || null;
export function publicPoll(p) {
  if (!p) return null;
  const total = p.options.reduce((n, o) => n + o.votes, 0);
  return { id: p.id, question: p.question, options: p.options.map((o) => ({ text: o.text, votes: o.votes })), total, startedAt: p.startedAt, endsAt: p.endsAt, open: p.open && Date.now() < p.endsAt };
}
export async function startPoll(uid, { question, options, minutes }) {
  const q = clean(question, 120);
  const opts = (Array.isArray(options) ? options : []).map((o) => clean(o, 60)).filter(Boolean).slice(0, 6);
  if (!q) throw Object.assign(new Error('Write a question'), { status: 400 });
  if (opts.length < 2) throw Object.assign(new Error('Add at least 2 options'), { status: 400 });
  const min = Math.min(60, Math.max(0.5, Number(minutes) || 2));
  const now = Date.now();
  const poll = { id: `p${now}`, question: q, options: opts.map((text) => ({ text, votes: 0 })), voters: {}, startedAt: now, endsAt: now + min * 60_000, open: true };
  await db.set(`poll/${uid}`, poll);
  return publicPoll(poll);
}
export async function endPoll(uid) {
  const p = await db.update(`poll/${uid}`, (P) => { if (!P) return undefined; P.open = false; P.endsAt = Math.min(P.endsAt, Date.now()); return P; }, null);
  return publicPoll(p);
}
export async function clearPoll(uid) { await db.del(`poll/${uid}`); }

/** Count votes from new chat messages. One vote per viewer (a later vote changes it). */
async function tallyVotes(uid, chats) {
  const votes = [];
  for (const m of chats) {
    if (m.kind && m.kind !== 'chat') continue;
    const t = textOf(m);
    const x = t.match(/^!vote\s+(\d{1,2})\b/i) || t.match(/^(\d{1,2})$/);
    if (x) votes.push({ who: `${m.platform}:${String(m.author?.name || '').toLowerCase()}`, n: Number(x[1]) });
  }
  if (!votes.length) return;
  await db.update(`poll/${uid}`, (P) => {
    if (!P || !P.open || Date.now() >= P.endsAt) return undefined;
    let changed = false;
    for (const v of votes) {
      const i = v.n - 1;
      if (i < 0 || i >= P.options.length || P.voters[v.who] === i) continue;
      if (P.voters[v.who] !== undefined) P.options[P.voters[v.who]].votes -= 1;
      P.options[i].votes += 1;
      P.voters[v.who] = i;
      changed = true;
    }
    return changed ? P : undefined;
  }, null);
}

// ── Custom commands + timers ──
export const defaultTools = () => ({ commands: [], timers: [], youtube: true, kick: true });
export const toolSettings = (user) => ({ ...defaultTools(), ...(user.tools || {}) });
export function validateTools(b, cur) {
  const next = { ...cur };
  if (b.youtube !== undefined) next.youtube = !!b.youtube;
  if (b.kick !== undefined) next.kick = !!b.kick;
  if (b.commands !== undefined) {
    if (!Array.isArray(b.commands)) throw Object.assign(new Error('commands must be a list'), { status: 400 });
    const seen = new Set();
    next.commands = b.commands.slice(0, 30).map((c) => {
      let cmd = clean(c?.cmd, 25).toLowerCase(); // spaces → invalid (rejected below)
      if (cmd && !cmd.startsWith('!')) cmd = `!${cmd}`;
      return { cmd, reply: clean(c?.reply, 400), enabled: c?.enabled !== false };
    }).filter((c) => /^![a-z0-9_]{1,24}$/.test(c.cmd) && c.reply && !['!vote', '!egghistory'].includes(c.cmd) && !seen.has(c.cmd) && seen.add(c.cmd));
  }
  if (b.timers !== undefined) {
    if (!Array.isArray(b.timers)) throw Object.assign(new Error('timers must be a list'), { status: 400 });
    next.timers = b.timers.slice(0, 10).map((t) => ({ text: clean(t?.text, 400), every: Math.min(240, Math.max(5, Math.round(Number(t?.every) || 15))), enabled: t?.enabled !== false }))
      .filter((t) => t.text);
  }
  return next;
}
const fill = (text, m, max) => text.replace(/\{user\}/gi, m?.author?.name || '').replace(/\{platform\}/gi, m?.platform === 'kick' ? 'Kick' : 'YouTube').slice(0, max);

/**
 * Called with every batch of new chat messages (YouTube from the engine, Kick from webhooks).
 * Counts poll votes and returns command replies: [{ to: 'youtube'|'kick', text }].
 */
export async function processChats(uid, user, chats) {
  if (!chats?.length) return [];
  await tallyVotes(uid, chats).catch(() => {});
  const t = toolSettings(user);
  const cmds = t.commands.filter((c) => c.enabled);
  if (!cmds.length) return [];
  const hits = [];
  for (const m of chats) {
    if (m.kind && m.kind !== 'chat') continue;
    const word = textOf(m).split(/\s+/)[0].toLowerCase();
    const c = cmds.find((x) => x.cmd === word);
    if (c && t[m.platform] !== false) hits.push({ c, m });
  }
  if (!hits.length) return [];
  const out = [];
  await db.update(`cmds/${uid}`, (D) => {
    out.length = 0; // may re-run on an etag conflict
    D.cool = D.cool || {};
    if (D.day !== today()) { D.day = today(); D.yt = 0; }
    for (const { c, m } of hits) {
      const key = `${m.platform}:${c.cmd}`;
      if (Date.now() - (D.cool[key] || 0) < 20_000) continue; // 20 s cooldown per command per platform
      if (m.platform === 'youtube' && D.yt >= YT_DAILY) continue;
      D.cool[key] = Date.now();
      if (m.platform === 'youtube') D.yt += 1;
      out.push({ to: m.platform, text: fill(c.reply, m, m.platform === 'kick' ? KICK_MAX : YT_MAX), cmd: c.cmd });
    }
    return out.length ? D : undefined;
  }, { cool: {}, day: today(), yt: 0, timers: {} });
  return out;
}

/** Timers: each enabled timer posts every N minutes while you are live. `targets` = where the bot can post now. */
export async function timerPosts(uid, user, targets) {
  const t = toolSettings(user);
  const timers = t.timers.map((x, i) => ({ ...x, i })).filter((x) => x.enabled);
  const to = ['youtube', 'kick'].filter((p) => targets[p] && t[p] !== false);
  if (!timers.length || !to.length) return [];
  const out = [];
  await db.update(`cmds/${uid}`, (D) => {
    out.length = 0;
    D.timers = D.timers || {};
    if (D.day !== today()) { D.day = today(); D.yt = 0; }
    const now = Date.now();
    for (const x of timers) {
      const key = `${x.i}:${x.text.slice(0, 20)}`;
      if (!D.timers[key]) { D.timers[key] = now + x.every * 60_000; continue; } // first run: wait one interval
      if (now < D.timers[key]) continue;
      D.timers[key] = now + x.every * 60_000;
      for (const p of to) {
        if (p === 'youtube' && D.yt >= YT_DAILY) continue;
        if (p === 'youtube') D.yt += 1;
        out.push({ to: p, text: x.text.slice(0, p === 'kick' ? KICK_MAX : YT_MAX), timer: true });
      }
    }
    return D;
  }, { cool: {}, day: today(), yt: 0, timers: {} });
  return out;
}

// ── Stream summary (from chat history) ──
export async function summary(uid, hours, session) {
  const since = Date.now() - Math.min(72, Math.max(1, Number(hours) || 6)) * 3600_000;
  const items = (await readHistory(uid, { limit: 2000 })).rows.filter((x) => x.ts >= since);
  const chats = items.filter((x) => !x.kind || x.kind === 'chat');
  const by = (k) => items.filter((x) => x.alert === k || (k === 'superchat' && x.kind === 'superchat' && !x.alert));
  const top = new Map();
  for (const m of chats) {
    const k = `${m.platform}:${m.author}`;
    const e = top.get(k) || { name: m.author, platform: m.platform, n: 0 };
    e.n += 1;
    top.set(k, e);
  }
  const perPlatform = (p) => chats.filter((x) => x.platform === p).length;
  return {
    since, hours: Math.round((Date.now() - since) / 3600_000),
    messages: chats.length, youtubeMessages: perPlatform('youtube'), kickMessages: perPlatform('kick'),
    chatters: top.size,
    topChatters: [...top.values()].sort((a, b) => b.n - a.n).slice(0, 10),
    superchats: [...by('superchat'), ...by('sticker')].sort((a, b) => b.ts - a.ts).slice(0, 30).map((x) => ({ author: x.author, amount: x.amount, text: x.text, ts: x.ts })),
    members: by('member').length + by('milestone').length, giftedMembers: by('gift').filter((x) => x.platform === 'youtube').length,
    kickSubs: by('sub').length, kickGifts: by('gift').filter((x) => x.platform === 'kick').length, follows: by('follow').length,
    greetings: by('greeting').length,
    peak: session || null,
  };
}

// The "watcher". Serverless has no always-on process, so every poll from a widget or the
// dashboard calls tick(), which does whatever YouTube/Kick work is due right now.
import * as db from './store.js';
import { addEvents, addLogs } from './feed.js';
import { youtubeStep, youtubeDue, postChat, youtubeBotReady } from './youtube.js';
import { eggStep } from './eggs.js';
import { config } from './config.js';
import { kickStep, kickDue, postKickChat, kickChatReady } from './kick.js';
import { updateUser, getSystemBot } from './auth.js';

const PLATFORMS = ['youtube', 'kick'];
export const blankPlatform = () => ({
  connected: false, live: false, viewers: null, subscribers: null, followers: null, title: null, url: null,
  channelName: null, avatar: null, chatConnected: false, chatMode: null, error: null,
});
const blankLive = () => ({ youtube: blankPlatform(), kick: blankPlatform(), _lockUntil: 0, updatedAt: Date.now() });
const DUE = { youtube: youtubeDue, kick: kickDue };
const STEP = { youtube: youtubeStep, kick: kickStep };

export async function tick(user) {
  const uid = user.id;
  const now = Date.now();
  let live = (await db.get(`live/${uid}`)) || blankLive();
  const due = PLATFORMS.filter((p) => user.accounts?.[p] && DUE[p](live[p] || {}, now));
  const eggsDue = !!(user.egg?.channelId && config.discord.botToken && now >= (live.eggs?._nextAt || 0));
  if ((!due.length && !eggsDue) || live._lockUntil > now) return live;

  // Short lock so several OBS sources polling at once don't repeat the same API calls.
  let claimed = false;
  live = await db.update(`live/${uid}`, (L) => {
    claimed = false; // may re-run on an etag conflict — only the winning write counts
    if (L._lockUntil > now) return undefined;
    L._lockUntil = now + 9_000;
    claimed = true;
    return L;
  }, blankLive());
  if (!claimed) return live;

  const chats = [];
  const deletes = [];
  const logs = [];
  const commands = [];
  const states = {};
  let accPatch = null;
  for (const p of PLATFORMS) {
    const acc = user.accounts?.[p];
    const st = { ...blankPlatform(), ...(live[p] || {}) };
    if (acc && due.includes(p)) {
      const ctx = { uid, st, chats, deletes, logs, commands, accPatch: null };
      try { await STEP[p](ctx, acc); } catch (e) { st.error = e.message; logs.push({ level: 'error', source: p, message: e.message }); }
      if (ctx.accPatch) accPatch = { p, patch: ctx.accPatch };
    }
    states[p] = acc ? st : blankPlatform();
  }

  // Egg Bot: Discord → history → YouTube chat (announcements + !egghistory replies)
  const eggState = { ...(live.eggs || {}) };
  if (eggsDue || commands.length) {
    const yt = states.youtube;
    const es = user.egg || {};
    const sharedBot = await getSystemBot();
    const targets = {
      youtube: es.youtube !== false && !!(yt.live && yt._chatId) && youtubeBotReady(user, sharedBot),
      kick: es.kick !== false && !!states.kick.live && kickChatReady(user.accounts?.kick),
    };
    try {
      const r = await eggStep({ uid, user, eggState, commands, targets });
      logs.push(...r.logs);
      const sent = { youtube: 0, kick: 0 };
      for (const p of r.posts) {
        try {
          if (p.to === 'youtube') await postChat(uid, yt._chatId, p.text);
          else await postKickChat(uid, p.text);
          sent[p.to] += 1;
        } catch (e) { logs.push({ level: 'warn', source: 'eggs', message: `${p.to} chat post failed: ${e.message}` }); }
      }
      if (sent.youtube || sent.kick) logs.push({ level: 'info', source: 'eggs', message: `Egg Bot posted — YouTube: ${sent.youtube}, Kick: ${sent.kick}` });
    } catch (e) {
      eggState.error = e.message;
      logs.push({ level: 'error', source: 'eggs', message: e.message });
    }
  }

  live = await db.update(`live/${uid}`, (L) => {
    for (const p of PLATFORMS) L[p] = states[p];
    L.eggs = eggState;
    L._lockUntil = 0;
    L.updatedAt = Date.now();
    return L;
  }, blankLive());

  await Promise.all([
    addEvents(uid, { chats, deletes, historyDays: user.historyDays ?? 7 }),
    addLogs(uid, logs),
    accPatch ? updateUser(uid, (u) => { const a = u?.accounts?.[accPatch.p]; if (!a) return undefined; Object.assign(a, accPatch.patch); return u; }) : null,
  ]);
  return live;
}

/** State sent to browsers: private _fields removed; widgets never see internal errors. */
export function publicState(live, user, { forWidget = false } = {}) {
  const out = { updatedAt: live?.updatedAt || Date.now() };
  for (const p of PLATFORMS) {
    const acc = user.accounts?.[p];
    const st = {};
    for (const [k, v] of Object.entries(live?.[p] || blankPlatform())) if (!k.startsWith('_')) st[k] = v;
    if (!acc) Object.assign(st, blankPlatform());
    else {
      st.connected = true;
      st.channelName ||= acc.channelName;
      st.avatar ||= acc.avatar;
      if (p === 'kick') st.followers = acc.kickFollowers ?? null;
    }
    if (forWidget) st.error = null;
    out[p] = st;
  }
  return out;
}

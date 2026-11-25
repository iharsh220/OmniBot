// Daily YouTube Data API v3 quota unit tracking (resets at midnight Pacific Time, matching Google's quota clock).
import * as db from './store.js';

export const YT_DAILY_LIMIT = 10_000;
const COST = { '/liveChat/messages': 5, '/channels': 1, '/videos': 1, '/liveBroadcasts': 1, '/playlistItems': 1 };

export const ytCost = (path) => COST[path] || 1;
export const ytQuotaDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

export async function addYtQuota(uid, { chat = 0, post = 0, other = 0, calls = 0 } = {}) {
  const units = chat + post + other;
  if (!uid || (!units && !calls)) return;
  const day = ytQuotaDay();
  const key = `quota/${day}`;
  try {
    await db.update(key, (Q) => {
      Q.day = day;
      Q.total = (Q.total || 0) + units;
      Q.users ||= {};
      const u = Q.users[uid] || { total: 0, chat: 0, post: 0, other: 0, calls: 0 };
      u.total += units;
      u.chat += chat;
      u.post += post;
      u.other += other;
      u.calls += calls;
      u.lastAt = Date.now();
      Q.users[uid] = u;
      return Q;
    }, { day, total: 0, users: {} });
  } catch { /* never let quota accounting break YouTube features */ }
}

export async function readYtQuota(day = ytQuotaDay()) {
  const doc = await db.get(`quota/${day}`);
  return { day, limit: YT_DAILY_LIMIT, total: doc?.total || 0, users: doc?.users || {} };
}

/** Daily history + per-user totals across an optional [from, to] YYYY-MM-DD range (and optional uid filter). */
export async function readYtQuotaHistory({ from = '', to = '', uid = '' } = {}) {
  const allDays = (await db.scan('quota/'))
    .map((k) => k.slice('quota/'.length))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a));

  const selected = allDays.filter((d) => (!from || d >= from) && (!to || d <= to));
  const docs = selected.length ? await db.mget(selected.map((d) => `quota/${d}`)) : [];

  const days = [];
  const byUser = new Map();
  const summary = { total: 0, chat: 0, post: 0, other: 0, calls: 0, days: 0, avgPerDay: 0 };

  for (let i = 0; i < selected.length; i++) {
    const day = selected[i];
    const doc = docs[i];
    if (!doc) continue;
    const entries = Object.entries(doc.users || {});
    let dTotal = 0; let dChat = 0; let dPost = 0; let dOther = 0; let dCalls = 0; let dUsers = 0;

    for (const [id, u] of entries) {
      const cur = byUser.get(id) || { uid: id, total: 0, chat: 0, post: 0, other: 0, calls: 0, daysActive: 0, lastAt: 0 };
      cur.total += u.total || 0;
      cur.chat += u.chat || 0;
      cur.post += u.post || 0;
      cur.other += u.other || 0;
      cur.calls += u.calls || 0;
      cur.daysActive += 1;
      if ((u.lastAt || 0) > cur.lastAt) cur.lastAt = u.lastAt;
      byUser.set(id, cur);

      if (!uid || uid === id) {
        dTotal += u.total || 0;
        dChat += u.chat || 0;
        dPost += u.post || 0;
        dOther += u.other || 0;
        dCalls += u.calls || 0;
        if (u.total || u.calls) dUsers += 1;
      }
    }

    if (!uid || dTotal || dCalls) {
      days.push({ day, total: dTotal, chat: dChat, post: dPost, other: dOther, calls: dCalls, usersCount: dUsers });
      summary.total += dTotal;
      summary.chat += dChat;
      summary.post += dPost;
      summary.other += dOther;
      summary.calls += dCalls;
    }
  }

  summary.days = days.length;
  summary.avgPerDay = days.length ? Math.round(summary.total / days.length) : 0;

  return {
    today: ytQuotaDay(),
    limit: YT_DAILY_LIMIT,
    minDay: allDays.at(-1) || ytQuotaDay(),
    maxDay: allDays[0] || ytQuotaDay(),
    summary,
    days,
    users: [...byUser.values()].sort((a, b) => b.total - a.total),
  };
}

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
    let created = false;
    await db.update(key, (Q) => {
      created = !Q.total && !Object.keys(Q.users || {}).length;
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
    if (created) await db.expire(key, 3 * 86_400);
  } catch { /* never let quota accounting break YouTube features */ }
}

export async function readYtQuota(day = ytQuotaDay()) {
  const doc = await db.get(`quota/${day}`);
  return { day, limit: YT_DAILY_LIMIT, total: doc?.total || 0, users: doc?.users || {} };
}

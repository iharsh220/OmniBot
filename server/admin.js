// Admin panel API: only the OmniChat Bot account (server-side check on every request).
// Read only, except marking a support request open / resolved.
// Never returned: tokens, session hashes, widget URLs, chat messages, donations, UPI ids.
import express from 'express';
import * as db from './store.js';
import { storeMode } from './store.js';
import { config } from './config.js';
import { ah } from './http.js';
import { isBotAccount, normalizeAccounts, sessionCount, getSystemBot, getSystemKickBot } from './auth.js';
import { readLogs } from './feed.js';
import { readFeed } from './eggs.js';
import { listTickets, readTicket, readShot, setTicketStatus, mailReady } from './support.js';
import { adminDiscord, userDiscord } from './discord.js';
import { issue, record, readList, searchList, LIST_MAX, AUDIT_DAYS } from './audit.js';
import { readYtQuota } from './quota.js';

const DAY = 86_400_000;
const ACTIVE_MS = 10 * 60_000;
const str = (v, n = 100) => String(v ?? '').trim().slice(0, n);
const int = (v, d, max) => Math.min(max, Math.max(0, Math.floor(Number(v)) || d));

function userRow(u, live, seen, quotaUnits = 0) {
  normalizeAccounts(u);
  const now = Date.now();
  // Streams are only checked while a dashboard/overlay is open, so an old "live" flag doesn't count.
  const current = !!live?.updatedAt && now - live.updatedAt < ACTIVE_MS;
  const accounts = Object.values(u.accounts || {}).map((a) => {
    const st = { ...(live?.[a.provider] || {}) };
    st.live = !!st.live && current;
    return {
      provider: a.provider, channelId: a.channelId, channelName: a.channelName, channelSlug: a.channelSlug || null, avatar: a.avatar || null,
      connectedAt: a.createdAt || null, live: !!st.live, viewers: st.live ? st.viewers ?? null : null, title: st.live ? st.title || null : null,
      error: st.error || null, reconnect: /reconnect/i.test(st.error || '') || !a.refreshToken,
    };
  });
  return {
    id: u.id, name: u.name, avatar: u.avatar || null, isBot: isBotAccount(u), createdAt: u.createdAt || null,
    lastLoginAt: u.lastLoginAt || null, loginCount: u.loginCount || 0,
    lastSeenAt: seen?.at || null, ip: seen?.ip || null, loc: seen?.loc || null, device: seen?.device || null,
    active: !!seen?.at && now - seen.at < ACTIVE_MS, overlayAt: seen?.overlayAt || null,
    accounts, live: accounts.some((a) => a.live), problem: accounts.some((a) => a.reconnect),
    discord: u.discord?.guildId ? { guildId: u.discord.guildId, server: u.discord.guildName || 'Discord server', enabled: !!u.discord.enabled } : null,
    eggBot: !!u.egg?.enabled, donations: !!u.donate?.enabled, widgets: (u.widgets || []).length, sessions: sessionCount(u), historyDays: u.historyDays ?? 7,
    quotaToday: quotaUnits,
  };
}

// The full user list is read from Redis, so it is shared for a few seconds between admin requests.
let cache = { at: 0, rows: null, pending: null };
async function allUsers() {
  if (cache.rows && Date.now() - cache.at < 15_000) return cache.rows;
  cache.pending ||= (async () => {
    const ids = (await db.scan('user/')).map((k) => k.slice('user/'.length));
    const [quota, ...groups] = await Promise.all([readYtQuota(), ...['user/', 'live/', 'seen/'].map((p) => db.mget(ids.map((id) => p + id)))]);
    const [users, live, seen] = groups;
    return users.map((u, i) => (u ? userRow(u, live[i], seen[i], quota.users[u.id]?.total || 0) : null)).filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  })();
  try { cache = { at: Date.now(), rows: await cache.pending, pending: null }; } catch (e) { cache.pending = null; throw e; }
  return cache.rows;
}
/** Add name + avatar to audit rows (names are joined here, never stored in the audit trail). */
async function withNames(rows) {
  const by = new Map((await allUsers()).map((u) => [u.id, u]));
  return rows.map((r) => ({ ...r, name: by.get(r.uid)?.name || null, avatar: by.get(r.uid)?.avatar || null }));
}

async function systemStatus() {
  const [yt, kick, feed] = await Promise.all([getSystemBot(), getSystemKickBot(), readFeed()]);
  return {
    store: storeMode(),
    mail: { ok: mailReady(), address: config.support.email || null },
    ytBot: { name: yt?.channelName || null, ok: !!(yt?.refreshToken && String(yt.scope || '').includes('youtube.force-ssl')) },
    kickBot: { name: kick?.channelName || null, ok: !!(kick?.refreshToken && String(kick.scope || '').split(/\s+/).includes('chat:write')) },
    discord: { ok: !!config.discord.botToken && !feed.error && !!feed.lastCheckAt, lastCheckAt: feed.lastCheckAt || null, error: feed.error || null },
  };
}

const admin = express.Router();
admin.use(ah(async (req, res, next) => {
  if (isBotAccount(req.user)) return next();
  await issue(req, { uid: req.user.id, level: 'warn', kind: 'access', message: 'Tried to open the admin panel', where: req.originalUrl.split('?')[0] });
  res.status(403).json({ error: 'Only the OmniChat Bot account can open the admin panel' });
}));

admin.get('/overview', ah(async (_req, res) => {
  const users = (await allUsers()).filter((u) => !u.isBot);
  const [system, recent, issues, tickets, quota] = await Promise.all([systemStatus(), readList('audit/all', 0, 12), readList('audit/issues', 0, 400), listTickets(), readYtQuota()]);
  const now = Date.now();
  const within = (ts, ms) => !!ts && now - ts < ms;
  const day = issues.filter((x) => within(x.ts, DAY));
  res.json({
    totals: {
      users: users.length, new7d: users.filter((u) => within(u.createdAt, 7 * DAY)).length,
      activeNow: users.filter((u) => u.active).length, active24h: users.filter((u) => within(u.lastSeenAt, DAY)).length,
      overlays: users.filter((u) => within(u.overlayAt, ACTIVE_MS)).length, live: users.filter((u) => u.live).length,
      signedIn24h: users.filter((u) => within(u.lastLoginAt, DAY)).length, problems: users.filter((u) => u.problem).length,
      youtube: users.filter((u) => u.accounts.some((a) => a.provider === 'youtube')).length,
      kick: users.filter((u) => u.accounts.some((a) => a.provider === 'kick')).length, eggBot: users.filter((u) => u.eggBot).length,
      errors24h: day.filter((x) => x.kind !== 'login').length, failedLogins24h: day.filter((x) => x.kind === 'login').length,
      openTickets: tickets.filter((t) => t.status === 'open').length,
    },
    system, quota: { day: quota.day, total: quota.total, limit: quota.limit }, recent: await withNames(recent), issues: await withNames(issues.slice(0, 6)),
    liveNow: users.filter((u) => u.live), keepDays: AUDIT_DAYS,
  });
}));

admin.get('/users', ah(async (_req, res) => res.json({ users: await allUsers() })));

admin.get('/users/:id([\\w-]{6,40})', ah(async (req, res) => {
  const { id } = req.params;
  const u = await db.get(`user/${id}`);
  if (!u) return res.status(404).json({ error: 'User not found (deleted account?)' });
  const [live, seen, actions, pages, logs, widgets, eggs, issues, discord, quota] = await Promise.all([
    db.get(`live/${id}`), db.get(`seen/${id}`), readList(`audit/${id}`, 0, 300), readList(`pages/${id}`, 0, 100), readLogs(id, { limit: 200 }),
    db.mget((u.widgets || []).map((w) => `widget/${w}`)), db.get(`eggs/${id}`),
    searchList('audit/issues', { max: LIST_MAX.issues, limit: 50, match: (x) => x.uid === id }), userDiscord(u), readYtQuota(),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const qUser = quota.users[id] || { total: 0, chat: 0, post: 0, other: 0, calls: 0 };
  res.json({
    user: userRow(u, live, seen, qUser.total),
    quotaToday: qUser,
    quotaDay: quota.day,
    ips: (seen?.ips || []).filter((x) => x.last > Date.now() - AUDIT_DAYS * DAY),
    activity: [...actions, ...pages].sort((a, b) => b.ts - a.ts),
    issues: issues.rows,
    discord,
    // donations are the streamer's own business: not part of the admin view
    logs: logs.rows.filter((l) => !/donation/i.test(l.message)),
    widgets: widgets.filter(Boolean).map((w) => ({ type: w.type, name: w.name, createdAt: w.createdAt, updatedAt: w.updatedAt })),
    eggPostsToday: eggs?.posted?.day === today ? eggs.posted.n : 0,
    tools: { commands: u.tools?.commands?.length || 0, timers: u.tools?.timers?.length || 0 },
  });
}));

/** Filters shared by activity + issues: ?kind= &q= &offset= &limit= */
async function search(req, key, max, fields) {
  const kind = str(req.query.kind, 20);
  const q = str(req.query.q).toLowerCase();
  const names = new Map((await allUsers()).map((u) => [u.id, u.name]));
  const hay = (x) => [...fields.map((f) => x[f]), names.get(x.uid), x.ip, x.device, x.loc?.city, x.loc?.country, x.id].filter(Boolean).join(' ').toLowerCase();
  const { rows, next } = await searchList(key, {
    max, offset: int(req.query.offset, 0, max), limit: int(req.query.limit, 100, 500) || 100,
    match: (x) => (!kind || x.kind === kind || (kind === 'failed' && x.ok === false)) && (!q || hay(x).includes(q)),
  });
  return { rows: await withNames(rows), next };
}
admin.get('/activity', ah(async (req, res) => res.json(await search(req, 'audit/all', LIST_MAX.all, ['action', 'detail', 'kind']))));
admin.get('/issues', ah(async (req, res) => res.json(await search(req, 'audit/issues', LIST_MAX.issues, ['message', 'where', 'kind']))));

admin.get('/discord', ah(async (_req, res) => res.json(await adminDiscord(await allUsers()))));

// ── Support requests ──
admin.get('/tickets', ah(async (_req, res) => res.json({ mail: mailReady(), email: config.support.email || null, tickets: await withNames(await listTickets()) })));
admin.get('/tickets/:id([\\w-]{6,20})', ah(async (req, res) => {
  const t = await readTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Request not found' });
  res.json({ ticket: (await withNames([t]))[0] });
}));
admin.put('/tickets/:id([\\w-]{6,20})', ah(async (req, res) => {
  const status = req.body?.status === 'resolved' ? 'resolved' : 'open';
  const t = await setTicketStatus(req.params.id, status);
  await record(req, { uid: req.user.id, kind: 'support', action: status === 'resolved' ? 'Resolved a support request' : 'Reopened a support request', detail: `#${t.id}` });
  res.json({ ok: true, status: t.status });
}));
admin.get('/shots/:id([\\w-]{8,40})', ah(async (req, res) => {
  const s = await readShot(req.params.id);
  if (!s) return res.status(404).json({ error: 'Screenshot not found' });
  res.set({ 'Content-Type': s.type, 'Content-Length': s.buf.length, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'" });
  res.end(s.buf);
}));

export default admin;

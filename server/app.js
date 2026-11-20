// OmniChat API as an Express app. Used by server/local.js (local dev) and by
// netlify/functions/api.mjs (Netlify, via serverless-http).
import express from 'express';
import { config, providersConfigured } from './config.js';
import { securityHeaders, sameOrigin, limit, ah } from './http.js';
import { randomId } from './crypto.js';
import * as db from './store.js';
import {
  authorize, clearStateCookie, handleCallback, currentUser, createSession, destroySession, destroyAllSessions,
  sessionCount, publicAccount, ensureDefaultWidgets, getUser, updateUser, disconnectAccount, deleteUser,
} from './auth.js';
import { log, addLogs, addEvents, readEvents, readLogs, readHistory } from './feed.js';
import { tick, publicState } from './engine.js';
import { verifyKickWebhook, webhookToEvents } from './kick.js';
import { eggSettings, readEggs, formatEgg, kickHistoryReply } from './eggs.js';
import { postChat, youtubeBotReady, usesSharedBot, canWriteChat } from './youtube.js';
import { postKickChat, kickChatReady } from './kick.js';
import { disconnectYouTubeBot, isAdmin, getSystemBot, saveSystemBot, disconnectSystemBot, renewSession } from './auth.js';
import { normalizeSettings } from '../public/js/settings.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// When running as a Netlify Function the path may arrive prefixed with the function path.
app.use((req, _res, next) => {
  req.url = req.url.replace(/^\/\.netlify\/functions\/api/, '') || '/';
  next();
});
app.use(['/api', '/auth', '/webhooks'], securityHeaders);

const WIDGET_TYPES = ['chat', 'stats'];
const cleanName = (v) => String(v ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60);
const widgetOut = (w) => ({ id: w.id, type: w.type, name: w.name, settings: w.settings || {}, updatedAt: w.updatedAt });
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
const setCookies = (res, cookies) => cookies.filter(Boolean).forEach((c) => res.append('Set-Cookie', c));

// ── OAuth ──────────────────────────────────────────────────────────────
app.get('/auth/:provider(youtube|kick)', limit('auth', 30, 60_000), ah(async (req, res) => {
  const { provider } = req.params;
  if (!providersConfigured()[provider]) return res.redirect(`/login?error=${encodeURIComponent(`${provider} login is not configured on this server`)}`);
  const user = await currentUser(req);
  // ?bot=1 (YouTube): connect the separate bot account that posts Egg Bot messages.
  // ?chat=1 (Kick): ask for chat:write so the Kick app bot can post (kept on later reconnects).
  const botAccount = provider === 'youtube' && req.query.bot === '1';
  const sharedBot = provider === 'youtube' && req.query.sharedbot === '1';
  if ((botAccount || sharedBot) && !user) return res.redirect('/login');
  if (sharedBot && !isAdmin(user)) return res.redirect(`/?error=${encodeURIComponent('Only an OmniChat admin can set the shared bot')}#eggs`);
  const chatWrite = provider === 'kick' && (req.query.chat === '1' || kickChatReady(user?.accounts?.kick));
  const a = authorize(provider, user?.id, { chatWrite, botAccount, sharedBot });
  setCookies(res, [a.cookie]);
  res.redirect(a.url);
}));

app.get('/auth/:provider(youtube|kick)/callback', limit('auth', 30, 60_000), ah(async (req, res) => {
  const { provider } = req.params;
  const user = await currentUser(req);
  try {
    const { uid, linked, bot } = await handleCallback(provider, req);
    setCookies(res, [clearStateCookie(), !linked || !user ? await createSession(uid) : null]);
    res.redirect(bot ? '/#eggs' : linked ? '/#connections' : '/');
  } catch (e) {
    if (user) await log(user.id, 'error', 'auth', `${provider} login failed: ${e.message}`);
    setCookies(res, [clearStateCookie()]);
    res.redirect(`${user ? '/?error=' : '/login?error='}${encodeURIComponent(e.message)}${user ? '#connections' : ''}`);
  }
}));

app.post('/auth/logout', ah(async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  setCookies(res, [await destroySession(req)]);
  res.json({ ok: true });
}));
app.post('/auth/logout-all', ah(async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  setCookies(res, [await destroyAllSessions(user.id)]);
  await log(user.id, 'info', 'auth', 'Signed out from all devices');
  res.json({ ok: true });
}));

// ── Kick webhooks (signed by Kick; raw body needed for the signature) ──
app.post('/webhooks/kick', limit('webhook', 1200, 60_000), express.raw({ type: '*/*', limit: '1mb' }), ah(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';
  if (!(await verifyKickWebhook(req.headers, raw))) return res.status(401).json({ error: 'Invalid signature' });
  let payload;
  try { payload = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const out = await webhookToEvents(String(req.headers['kick-event-type'] || ''), payload, String(req.headers['kick-event-message-id'] || ''));
  if (out) {
    await addEvents(out.uid, { chats: out.chats, historyDays: out.user.historyDays ?? 7 });
    if (out.followersDelta) await updateUser(out.uid, (u) => { const a = u?.accounts?.kick; if (!a || a.kickFollowers == null) return undefined; a.kickFollowers += out.followersDelta; return u; });
    if (out.statePatch) await db.update(`live/${out.uid}`, (L) => { L.kick = { ...(L.kick || {}), ...out.statePatch }; return L; }, { kick: {} });
    if (out.logs.length) await addLogs(out.uid, out.logs);
    // !egghistory typed in Kick chat → reply as the Kick bot
    const cmd = out.chats.find((m) => /^!egghistory\b/i.test((m.parts || []).map((x) => x.text || '').join('').trim()));
    if (cmd && kickChatReady(out.user.accounts?.kick)) {
      const reply = await kickHistoryReply(out.uid, out.user);
      if (reply) {
        try { await postKickChat(out.uid, reply); await log(out.uid, 'info', 'eggs', `!egghistory requested by ${cmd.author.name} (Kick)`); }
        catch (e) { await log(out.uid, 'warn', 'eggs', `Kick chat post failed: ${e.message}`); }
      }
    }
  }
  res.json({ ok: true });
}));

app.use(express.json({ limit: '200kb' }));

// ── Public widget endpoints (OBS / overlay apps — no login) ──
const ID = ':id([\\w-]{6,40})';
app.get(`/api/w/${ID}`, ah(async (req, res) => {
  const w = await db.get(`widget/${req.params.id}`);
  if (!w) return res.status(404).json({ error: 'Widget not found' });
  res.json({ id: w.id, type: w.type, settings: w.settings || {}, v: w.updatedAt });
}));
app.get(`/api/w/${ID}/poll`, limit('poll', 240, 60_000), ah(async (req, res) => {
  const w = await db.get(`widget/${req.params.id}`);
  const user = w && (await getUser(w.uid));
  if (!w || !user) return res.status(404).json({ error: 'Widget not found' });
  const live = await tick(user);
  const out = { ...(await readEvents(user.id, num(req.query.c))), state: publicState(live, user, { forWidget: true }), v: w.updatedAt };
  if (Number(req.query.v) !== w.updatedAt) out.settings = w.settings || {};
  res.json(out);
}));

app.get('/api/providers', (_req, res) => res.json(providersConfigured()));

// ── Authenticated API ──
const authed = ah(async (req, res, next) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  req.user = user;
  try { const c = await renewSession(req); if (c) setCookies(res, [c]); } catch { /* renewal is best effort */ }
  next();
});
const api = express.Router();
api.use(authed);
api.use((req, res, next) => (req.method === 'GET' ? next() : limit('write', 120, 60_000)(req, res, next)));

api.get('/me', ah(async (req, res) => {
  await ensureDefaultWidgets(req.user.id);
  const u = await getUser(req.user.id);
  const widgets = (await Promise.all((u.widgets || []).map((id) => db.get(`widget/${id}`)))).filter(Boolean).map(widgetOut);
  res.json({
    user: { id: u.id, name: u.name, avatar: u.avatar, createdAt: u.createdAt, historyDays: u.historyDays ?? 7, sessions: sessionCount(u) },
    accounts: Object.values(u.accounts || {}).map(publicAccount), widgets, providers: providersConfigured(), appUrl: config.appUrl,
  });
}));

api.get('/poll', limit('poll', 240, 60_000), ah(async (req, res) => {
  const live = await tick(req.user);
  const ev = await readEvents(req.user.id, num(req.query.c));
  const lc = num(req.query.l);
  const lg = await readLogs(req.user.id, { cursor: lc === undefined ? Number.MAX_SAFE_INTEGER : lc, limit: 50 });
  res.json({ ...ev, state: publicState(live, req.user), logs: lc === undefined ? [] : lg.rows.reverse(), logCursor: lg.cursor });
}));

api.put('/me/settings', ah(async (req, res) => {
  const days = Number(req.body?.historyDays);
  if (![0, 1, 7, 30].includes(days)) return res.status(400).json({ error: 'historyDays must be 0, 1, 7 or 30' });
  const uid = req.user.id;
  await updateUser(uid, (u) => ({ ...u, historyDays: days }));
  if (days === 0) await db.del(`history/${uid}`);
  else await db.update(`history/${uid}`, (H) => { H.items = H.items.filter((x) => x.ts > Date.now() - days * 86_400_000); return H; }, { items: [] });
  await log(uid, 'info', 'system', days ? `Chat history retention set to ${days} day(s)` : 'Chat history saving turned off');
  res.json({ ok: true, historyDays: days });
}));

api.delete('/me', ah(async (req, res) => {
  if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
  setCookies(res, [await destroySession(req)]);
  await deleteUser(req.user.id);
  console.log(`[auth] user ${req.user.id} deleted their account`);
  res.json({ ok: true });
}));

api.get('/messages', ah(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  res.json(await readHistory(req.user.id, { q, platform: req.query.platform, limit: Math.min(500, Number(req.query.limit) || 200) }));
}));
api.delete('/messages', ah(async (req, res) => {
  await db.del(`history/${req.user.id}`);
  await log(req.user.id, 'info', 'system', 'Chat history cleared');
  res.json({ ok: true });
}));

api.delete('/accounts/:provider(youtube|kick)', ah(async (req, res) => {
  if (Object.keys(req.user.accounts || {}).length <= 1) return res.status(400).json({ error: 'You need at least one connected account to sign in. Connect the other platform first.' });
  await disconnectAccount(req.user.id, req.params.provider);
  await log(req.user.id, 'info', 'auth', `${req.params.provider} disconnected (token revoked)`);
  res.json({ ok: true });
}));

// Kick ids/followers sent by the streamer's own browser (auto-sync) or a manual paste.
api.put(['/accounts/kick/sync', '/accounts/kick/chatroom'], ah(async (req, res) => {
  const b = req.body || {};
  const toInt = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return undefined;
    const n = Number(String(v).trim());
    return Number.isInteger(n) && n >= 0 && n < 1e12 ? n : NaN;
  };
  const vals = { kickChatroomId: toInt(b.chatroomId), kickChannelId: toInt(b.channelId), kickFollowers: toInt(b.followers) };
  if (Object.values(vals).some((v) => Number.isNaN(v))) return res.status(400).json({ error: 'Values must be numbers' });
  if (!req.user.accounts?.kick) return res.status(400).json({ error: 'Connect Kick first' });
  const changed = Object.entries(vals).filter(([k, v]) => v !== undefined && req.user.accounts.kick[k] !== v);
  let acc = req.user.accounts.kick;
  if (changed.length) {
    const u = await updateUser(req.user.id, (x) => { const a = x?.accounts?.kick; if (!a) return undefined; for (const [k, v] of changed) a[k] = v; return x; });
    acc = u.accounts.kick;
    await log(req.user.id, 'info', 'kick', `${b.auto ? 'Auto-synced' : 'Synced'} from Kick: ${changed.map(([k, v]) => `${k.replace('kick', '').toLowerCase()}=${v}`).join(', ')}`);
  }
  res.json({ ok: true, account: publicAccount(acc), chatroomId: acc.kickChatroomId ?? null });
}));

api.post('/watchers/restart', ah(async (req, res) => {
  await db.del(`live/${req.user.id}`);
  await log(req.user.id, 'info', 'system', 'Watchers restarted from dashboard');
  res.json({ ok: true });
}));

api.post('/widgets', ah(async (req, res) => {
  const b = req.body || {};
  if ((req.user.widgets || []).length >= 50) return res.status(400).json({ error: 'Widget limit reached (50)' });
  const type = WIDGET_TYPES.includes(b.type) ? b.type : 'chat';
  const now = Date.now();
  const w = { id: randomId(9), uid: req.user.id, type, name: cleanName(b.name) || `New ${type} widget`, settings: normalizeSettings(b.settings), createdAt: now, updatedAt: now };
  await db.set(`widget/${w.id}`, w);
  await updateUser(req.user.id, (u) => ({ ...u, widgets: [...(u.widgets || []), w.id] }));
  res.json(widgetOut(w));
}));

const ownWidget = async (req, res) => {
  const w = await db.get(`widget/${req.params.id}`);
  if (!w || w.uid !== req.user.id) { res.status(404).json({ error: 'Widget not found' }); return null; }
  return w;
};
api.post(`/widgets/${ID}/rotate`, ah(async (req, res) => {
  const w = await ownWidget(req, res);
  if (!w) return;
  const nw = { ...w, id: randomId(9), updatedAt: Date.now() };
  await db.set(`widget/${nw.id}`, nw);
  await updateUser(req.user.id, (u) => ({ ...u, widgets: (u.widgets || []).map((id) => (id === w.id ? nw.id : id)) }));
  await db.del(`widget/${w.id}`);
  await log(req.user.id, 'info', 'system', `Widget "${w.name}" got a new URL (old URL disabled)`);
  res.json(widgetOut(nw));
}));
api.put(`/widgets/${ID}`, ah(async (req, res) => {
  const w = await ownWidget(req, res);
  if (!w) return;
  const b = req.body || {};
  const next = await db.update(`widget/${w.id}`, (x) => ({
    ...x,
    name: b.name !== undefined ? cleanName(b.name) || x.name : x.name,
    settings: b.settings !== undefined ? normalizeSettings(b.settings) : x.settings,
    updatedAt: Date.now(),
  }), w);
  res.json(widgetOut(next));
}));
api.delete(`/widgets/${ID}`, ah(async (req, res) => {
  const w = await ownWidget(req, res);
  if (!w) return;
  await db.del(`widget/${w.id}`);
  await updateUser(req.user.id, (u) => ({ ...u, widgets: (u.widgets || []).filter((id) => id !== w.id) }));
  res.json({ ok: true });
}));

// ── Egg Bot ──
api.get('/eggs', ah(async (req, res) => {
  const [doc, live, sharedBot] = await Promise.all([readEggs(req.user.id), db.get(`live/${req.user.id}`), getSystemBot()]);
  const yt = live?.youtube || {};
  const botInfo = (b) => (b ? { channelName: b.channelName, avatar: b.avatar, ready: canWriteChat(b) } : null);
  res.json({
    settings: eggSettings(req.user),
    items: doc.items,
    rarities: [...new Set(doc.items.map((e) => e.rarity).filter(Boolean))],
    status: {
      botConfigured: !!config.discord.botToken,
      youtubeConnected: !!req.user.accounts?.youtube,
      botMode: usesSharedBot(req.user) ? 'shared' : 'own',
      sharedBot: botInfo(sharedBot),
      ownBot: botInfo(req.user.ytBot),
      youtubeBot: botInfo(usesSharedBot(req.user) ? sharedBot : req.user.ytBot),
      youtubeBotReady: youtubeBotReady(req.user, sharedBot),
      isAdmin: isAdmin(req.user),
      ytLive: !!(yt.live && yt._chatId),
      kickConnected: !!req.user.accounts?.kick,
      kickChatReady: kickChatReady(req.user.accounts?.kick),
      kickLive: !!live?.kick?.live,
      error: live?.eggs?.error || null,
      lastCheckAt: live?.eggs?.lastCheckAt || null,
      postedToday: doc.posted?.day === new Date().toISOString().slice(0, 10) ? doc.posted.n : 0,
      dailyLimit: config.eggs.dailyPostLimit,
    },
  });
}));

api.put('/eggs/settings', ah(async (req, res) => {
  const b = req.body || {};
  const cur = eggSettings(req.user);
  const next = { ...cur };
  if (b.enabled !== undefined) next.enabled = !!b.enabled;
  if (b.commandEnabled !== undefined) next.commandEnabled = !!b.commandEnabled;
  if (b.youtube !== undefined) next.youtube = !!b.youtube;
  if (b.botMode !== undefined) {
    if (!['shared', 'own'].includes(b.botMode)) return res.status(400).json({ error: 'botMode must be shared or own' });
    next.botMode = b.botMode;
  }
  if (b.kick !== undefined) next.kick = !!b.kick;
  if (b.channelId !== undefined) {
    const id = String(b.channelId).trim();
    if (id && !/^\d{15,25}$/.test(id)) return res.status(400).json({ error: 'Channel ID must be the long number from Discord (Copy Channel ID)' });
    next.channelId = id;
  }
  if (b.rarities !== undefined) {
    if (!Array.isArray(b.rarities)) return res.status(400).json({ error: 'rarities must be a list' });
    next.rarities = [...new Set(b.rarities.map(String).filter((r) => /^[A-Za-z]{1,20}$/.test(r)))].slice(0, 20);
  }
  await updateUser(req.user.id, (u) => ({ ...u, egg: next }));
  if (next.channelId !== cur.channelId) {
    await db.del(`eggs/${req.user.id}`); // new channel → fresh history
    await db.update(`live/${req.user.id}`, (L) => { L.eggs = {}; return L; }, {});
  }
  const changes = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
  if (changes.length) await log(req.user.id, 'info', 'eggs', `Egg Bot settings changed: ${changes.map((k) => `${k}=${Array.isArray(next[k]) ? next[k].join('/') || 'all' : next[k]}`).join(', ')}`);
  res.json({ ok: true, settings: next });
}));

api.post('/eggs/test', ah(async (req, res) => {
  const live = await db.get(`live/${req.user.id}`);
  const yt = live?.youtube || {};
  const doc = await readEggs(req.user.id);
  const text = doc.items[0] ? formatEgg(doc.items[0]) : '🥚 OmniChat Egg Bot is connected!';
  const result = {};
  const sharedBot = await getSystemBot();
  const shared = usesSharedBot(req.user);
  if (youtubeBotReady(req.user, sharedBot) && yt.live && yt._chatId) {
    try { await postChat(req.user.id, yt._chatId, text, { shared }); result.youtube = 'sent'; } catch (e) { result.youtube = e.message; }
  } else result.youtube = !youtubeBotReady(req.user, sharedBot) ? (shared ? 'the shared OmniChat Bot is not set up yet' : 'connect your YouTube bot account first') : 'go live on YouTube first';
  if (kickChatReady(req.user.accounts?.kick)) {
    try { await postKickChat(req.user.id, text); result.kick = 'sent'; } catch (e) { result.kick = e.message; }
  } else result.kick = req.user.accounts?.kick ? 'give Kick chat permission first' : 'connect Kick first';
  await log(req.user.id, 'info', 'eggs', `Test message → YouTube: ${result.youtube} · Kick: ${result.kick}`);
  res.json({ ok: true, text, result });
}));

// Admin: the shared OmniChat Bot used by every streamer
api.post('/admin/shared-bot/use-mine', ah(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  if (!canWriteChat(req.user.ytBot)) return res.status(400).json({ error: 'Connect your own bot account first' });
  // Move (not copy) so that disconnecting a personal bot can never revoke the shared bot's token.
  await saveSystemBot({ ...req.user.ytBot, createdAt: Date.now() });
  await updateUser(req.user.id, (u) => { delete u.ytBot; u.egg = { ...(u.egg || {}), botMode: 'shared' }; return u; });
  await log(req.user.id, 'info', 'eggs', `Shared OmniChat Bot set to: ${req.user.ytBot.channelName}`);
  res.json({ ok: true });
}));
api.delete('/admin/shared-bot', ah(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' });
  await disconnectSystemBot();
  await log(req.user.id, 'info', 'eggs', 'Shared OmniChat Bot removed (token revoked)');
  res.json({ ok: true });
}));

api.delete('/eggs/bot', ah(async (req, res) => {
  await disconnectYouTubeBot(req.user.id);
  await log(req.user.id, 'info', 'eggs', 'YouTube bot account disconnected (token revoked)');
  res.json({ ok: true });
}));

api.get('/logs', ah(async (req, res) => {
  const r = await readLogs(req.user.id, { level: req.query.level, q: String(req.query.q || '').trim().slice(0, 100), limit: Math.min(500, Number(req.query.limit) || 200) });
  res.json(r.rows);
}));
api.delete('/logs', ah(async (req, res) => {
  await db.del(`logs/${req.user.id}`);
  res.json({ ok: true });
}));

app.use('/api', api);
app.use(['/api', '/auth', '/webhooks'], (_req, res) => res.status(404).json({ error: 'Not found' }));

// Errors → JSON (no stack traces to clients).
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

export default app;

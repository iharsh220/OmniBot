// OmniChat API as an Express app. Used by server/local.js (local dev) and by Vercel
// (root app.js/index.js and api/*.mjs).
import express from 'express';
import { config, providersConfigured } from './config.js';
import { securityHeaders, sameOrigin, limit, ah, parseCookies, reqHost } from './http.js';
import { randomId } from './crypto.js';
import * as db from './store.js';
import { storeMode } from './store.js';
import {
  authorize, clearStateCookie, handleCallback, currentUser, createSession, destroySession, destroyAllSessions,
  sessionCount, publicAccount, ensureDefaultWidgets, getUser, updateUser, disconnectAccount, deleteUser,
  listAccounts, findAccount,
} from './auth.js';
import { log, addLogs, addEvents, readEvents, readLogs, readHistory } from './feed.js';
import { tick, publicState } from './engine.js';
import { verifyKickWebhook, webhookToEvents } from './kick.js';
import { boardList, eggSettings, readEggs, readFeed, refreshGlobalFeed, formatEgg, kickHistoryReply, getEggChannelId, setEggChannelId } from './eggs.js';
import { postChat, youtubeBotReady, canWriteChat } from './youtube.js';
import { postKickChat, kickBotReady } from './kick.js';
import { isBotAccount, getSystemBot, getSystemKickBot, renewSession, lastLoginCookie, readLastLogin, clearLastLogin } from './auth.js';
import { normalizeSettings } from '../public/js/settings.js';
import { saveMedia, readMedia, deleteMedia, MAX_BYTES } from './media.js';
import QRCode from 'qrcode';
import { donateSettings, validateDonate, publicDonate, submitDonation, readDonations, confirmDonation, dismissDonation, addManualDonation } from './donate.js';
import { record, issue, recordPage, markSeen, markOverlay, forgetUser, auditWrites } from './audit.js';
import admin from './admin.js';
import { SHOT_BYTES, CATEGORIES, saveShot, createTicket, listTickets, mailReady, forgetTickets } from './support.js';
import { numberAlerts, testAlert, highlightMessage, clearHighlight, readPoll, publicPoll, startPoll, endPoll, clearPoll, processChats, toolSettings, validateTools, summary } from './tools.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, _res, next) => {
  // Vercel catch-all rewrites /auth/* and /webhooks/* into /api/auth/* and /api/webhooks/*.
  req.url = req.url.replace(/^\/api\/(?=auth(?:\/|$)|webhooks(?:\/|$))/, '/');
  next();
});
app.use(['/api', '/auth', '/webhooks'], securityHeaders);

const WIDGET_TYPES = ['chat', 'stats', 'eggs', 'alerts', 'goal', 'poll', 'donate'];
const cleanName = (v) => String(v ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60);
const widgetOut = (w) => ({ id: w.id, type: w.type, name: w.name, settings: w.settings || {}, updatedAt: w.updatedAt });
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
const setCookies = (res, cookies) => cookies.flat().filter(Boolean).forEach((c) => res.append('Set-Cookie', c));
/** APP_URL's host when the request came in on a different domain (Vercel preview/alias), else null. */
function otherHost(req) {
  let want = '';
  try { want = new URL(config.appUrl).host.toLowerCase(); } catch { return null; }
  const got = reqHost(req);
  return got && want && got !== want && !/^(localhost|127\.0\.0\.1)(:|$)/.test(want) ? want : null;
}

// â”€â”€ OAuth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/auth/:provider(youtube|kick)', limit('auth', 30, 60_000), ah(async (req, res) => {
  const { provider } = req.params;
  if (!providersConfigured()[provider]) return res.redirect(`/login?error=${encodeURIComponent(`${provider} login is not configured on this server`)}`);
  // OAuth always returns to APP_URL. Start the flow on that same domain, otherwise the state cookie and
  // the session cookie would live on two different domains and the dashboard would see "no session cookie".
  const canonical = otherHost(req);
  if (canonical) return res.redirect(`${config.appUrl}${req.originalUrl.replace(/^\/api(?=\/auth\/)/, '')}`);
  const user = await currentUser(req);
  // ?bot=1 (YouTube): connect the separate bot account that posts Egg Bot messages.
  // ?chat=1 (Kick): ask for chat:write so the Kick app bot can post (kept on later reconnects).
  const sharedBot = provider === 'youtube' && req.query.sharedbot === '1';
  if (sharedBot && !user) return res.redirect('/login');
  // Allow through to OAuth; handleCallback verifies the picked Google account is the configured bot.
  const chatWrite = provider === 'kick' && (req.query.chat === '1' || String(user?.accounts?.kick?.scope || '').split(/\s+/).includes('chat:write'));
  // Google: first YouTube sign-in on this browser → the consent page right away (it gives the refresh token),
  // so the streamer sees Google only ONCE. Afterwards just the account picker.
  const firstYouTube = provider === 'youtube' && !(readLastLogin(req)?.used || []).includes('youtube');
  const a = authorize(provider, user?.id, { chatWrite, sharedBot, consent: req.query.consent === '1' || firstYouTube, req });
  setCookies(res, [a.cookie]);
  res.redirect(a.url);
}));

app.get('/auth/:provider(youtube|kick)/callback', limit('auth', 30, 60_000), ah(async (req, res) => {
  const { provider } = req.params;
  const user = await currentUser(req);
  try {
    const { uid, linked, bot, needsBotScope, needsConsent, created, channelName } = await handleCallback(provider, req);
    const fresh = !linked || !user;
    setCookies(res, [clearStateCookie(req), fresh ? await createSession(uid, req) : null]);
    const label = provider === 'youtube' ? 'YouTube' : 'Kick';
    if (fresh) await updateUser(uid, (u) => (u ? { ...u, lastLoginAt: Date.now(), loginCount: (u.loginCount || 0) + 1 } : undefined));
    await record(req, {
      uid, kind: 'auth', dedupeMs: 60_000, detail: [label, channelName].filter(Boolean).join(': '),
      action: bot ? 'Reconnected the OmniChat Bot' : created ? 'Created account' : fresh ? 'Signed in' : 'Connected platform',
    });
    await markSeen(req, uid);
    if (!bot) setCookies(res, [lastLoginCookie(req, await getUser(uid), provider)]);
    // The OmniChat Bot account just signed in â†’ straight on to the chat-post permission (automatic setup).
    if (needsBotScope) return res.redirect('/auth/youtube?sharedbot=1');
    // First YouTube login with the one-click prompt gave no refresh token → ask Google's consent once.
    if (needsConsent) return res.redirect('/auth/youtube?consent=1');
    res.redirect(bot ? '/#eggs' : linked ? '/#connections' : '/');
  } catch (e) {
    if (user) await addLogs(user.id, [{ level: 'error', source: 'auth', message: `${provider} login failed: ${e.message}`, noIssue: true }]);
    await issue(req, { uid: user?.id, level: 'warn', kind: 'login', message: `${provider} login failed: ${e.message}`, dedupeMs: 60_000 });
    setCookies(res, [clearStateCookie(req)]);
    res.redirect(`${user ? '/?error=' : '/login?error='}${encodeURIComponent(e.message)}${user ? '#connections' : ''}`);
  }
}));

app.post('/auth/logout', ah(async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  const user = await currentUser(req);
  setCookies(res, [await destroySession(req)]);
  if (user) await record(req, { uid: user.id, kind: 'auth', action: 'Signed out' });
  res.json({ ok: true });
}));
app.post('/auth/logout-all', ah(async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  setCookies(res, [await destroyAllSessions(user.id, req)]);
  await log(user.id, 'info', 'auth', 'Signed out from all devices');
  await record(req, { uid: user.id, kind: 'auth', action: 'Signed out from all devices' });
  res.json({ ok: true });
}));

// â”€â”€ Kick webhooks (signed by Kick; raw body needed for the signature) â”€â”€
app.post('/webhooks/kick', limit('webhook', 1200, 60_000), express.raw({ type: '*/*', limit: '1mb' }), ah(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';
  if (!(await verifyKickWebhook(req.headers, raw))) return res.status(401).json({ error: 'Invalid signature' });
  let payload;
  try { payload = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const out = await webhookToEvents(String(req.headers['kick-event-type'] || ''), payload, String(req.headers['kick-event-message-id'] || ''));
  if (out) {
    await numberAlerts(out.uid, out.chats).catch(() => {});
    await addEvents(out.uid, { chats: out.chats, historyDays: out.user.historyDays ?? 7 });
    if (out.followersDelta) await updateUser(out.uid, (u) => { const a = u?.accounts?.kick; if (!a || a.kickFollowers == null) return undefined; a.kickFollowers += out.followersDelta; return u; });
    if (out.statePatch) await db.update(`live/${out.uid}`, (L) => { L.kick = { ...(L.kick || {}), ...out.statePatch }; return L; }, { kick: {} });
    if (out.logs.length) await addLogs(out.uid, out.logs);
    // !egghistory typed in Kick chat â†’ reply as the Kick bot
    // Live tools: poll votes + custom commands typed in Kick chat
    try {
      const replies = (await processChats(out.uid, out.user, out.chats)).filter((r) => r.to === 'kick');
      if (replies.length && await kickBotReady()) {
        const kickAcc = findAccount(out.user, 'kick', out.broadcasterId) || listAccounts(out.user, 'kick')[0];
        for (const r of replies) {
          try { await postKickChat(kickAcc.channelId, r.text); await log(out.uid, 'info', 'bot', `${r.cmd} → kick`); }
          catch (e) { await log(out.uid, 'warn', 'bot', `Kick chat post failed: ${e.message}`); }
        }
      }
    } catch (e) { console.warn('[tools] kick', e.message); }
    const cmd = out.chats.find((m) => /^!egghistory\b/i.test((m.parts || []).map((x) => x.text || '').join('').trim()));
    if (cmd && await kickBotReady()) {
      const kickAcc = findAccount(out.user, 'kick', out.broadcasterId) || listAccounts(out.user, 'kick')[0];
      if (kickAcc?.channelId) {
        const reply = await kickHistoryReply(out.uid, out.user);
        if (reply) {
          try { await postKickChat(kickAcc.channelId, reply); await log(out.uid, 'info', 'eggs', `!egghistory requested by ${cmd.author.name} (Kick)`); }
          catch (e) { await log(out.uid, 'warn', 'eggs', `Kick chat post failed: ${e.message}`); }
        }
      }
    }
  }
  res.json({ ok: true });
}));

app.use(express.json({ limit: '200kb' }));

// â”€â”€ Public widget endpoints (OBS / overlay apps â€” no login) â”€â”€
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
  if (w.type === 'eggs') {
    // Eggs overlay: the shared Steal-an-Egg feed (refreshed at most once per EGG_POLL_MS for everyone).
    const { feed } = await refreshGlobalFeed();
    const out = { eggs: (feed.items || []).slice(0, 150), seen: boardList(feed), eggEvents: (feed.events || []).slice(0, 20), v: w.updatedAt };
    if (Number(req.query.v) !== w.updatedAt) out.settings = w.settings || {};
    return res.json(out);
  }
  const [live] = await Promise.all([tick(user), markOverlay(user.id)]);
  if (w.type === 'donate') {
    const out = { donate: publicDonate(user), v: w.updatedAt };
    if (Number(req.query.v) !== w.updatedAt) out.settings = w.settings || {};
    return res.json(out);
  }
  if (w.type === 'poll') {
    const out = { poll: publicPoll(await readPoll(user.id)), v: w.updatedAt };
    if (Number(req.query.v) !== w.updatedAt) out.settings = w.settings || {};
    return res.json(out);
  }
  const out = { ...(await readEvents(user.id, num(req.query.c))), state: publicState(live, user, { forWidget: true }), v: w.updatedAt };
  if (Number(req.query.v) !== w.updatedAt) out.settings = w.settings || {};
  res.json(out);
}));

// Public (login page): which providers work + the last login on THIS browser for "Continue as …".
const providersOut = (req) => ({ ...providersConfigured(), last: readLastLogin(req), supportEmail: config.support.email || null });
app.get('/api/providers', (req, res) => res.json(providersOut(req)));
// Deploy check: which storage is active (no secrets). On Vercel it must say "kv".
app.get('/api/health', (_req, res) => { let store; try { store = storeMode(); } catch { store = 'error'; } res.json({ ok: store !== 'missing', store, appUrl: config.appUrl }); });
// ── Donations (public): page data, "I've paid" note, QR code for upi:// links only ──
const UID = ':uid([\\w-]{6,40})';
app.get(`/api/donate/${UID}`, limit('poll', 240, 60_000), ah(async (req, res) => {
  const u = await getUser(req.params.uid);
  const d = u && publicDonate(u);
  if (!d) return res.status(404).json({ error: 'Donations are not set up for this streamer' });
  res.json(d);
}));
app.post(`/api/donate/${UID}`, limit('donate', 6, 60_000), ah(async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  const u = await getUser(req.params.uid);
  if (!u || !publicDonate(u)) return res.status(404).json({ error: 'Donations are not set up for this streamer' });
  await submitDonation(u.id, req.body || {});
  res.json({ ok: true });
}));
app.get('/api/qr.svg', limit('qr', 120, 60_000), ah(async (req, res) => {
  const d = String(req.query.d || '');
  let ok = /^upi:\/\/pay\?[\w%.@&=+-]{5,500}$/.test(d);
  if (!ok) { // or this site's own donation page /d/<id>
    try { const u = new URL(d); const hosts = [new URL(config.appUrl).host, reqHost(req)]; ok = /^https?:$/.test(u.protocol) && hosts.includes(u.host) && /^\/d\/[\w-]{6,40}$/.test(u.pathname) && !u.search; } catch { ok = false; }
  }
  if (!ok) return res.status(400).json({ error: 'Only UPI payment links or your donation page' });
  const svg = await QRCode.toString(d, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.send(svg);
}));

// Uploaded alert pictures / sounds (public: OBS loads them). Type was sniffed from the bytes at upload.
app.get('/api/media/:id([\\w-]{8,40})', limit('media', 600, 60_000), ah(async (req, res) => {
  const m = await readMedia(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.set({ 'Content-Type': m.type, 'Content-Length': m.buf.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
  res.end(m.buf);
}));
// "Not you?" on the login page: forget the remembered login on this browser.
app.post('/api/providers/forget', (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  setCookies(res, [clearLastLogin(req)]);
  res.json({ ok: true });
});


// â”€â”€ Authenticated API â”€â”€
const authed = ah(async (req, res, next) => {
  const user = await currentUser(req);
  if (!user) {
    // Shows up in Vercel → Logs, to diagnose unexpected sign-outs.
    console.warn(`[auth] 401 ${req.method} ${req.path}: ${req._authReason} (cookies: ${Object.keys(parseCookies(req)).join(',') || 'none'})`);
    return res.status(401).json({ error: 'Not logged in', reason: req._authReason });
  }
  if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  req.user = user;
  try { const c = await renewSession(req); if (c) setCookies(res, [c]); } catch { /* renewal is best effort */ }
  await markSeen(req, user.id);
  next();
});
const api = express.Router();
api.get('/providers', (req, res) => res.json(providersOut(req))); // public (login page)
api.use(authed);
api.use((req, res, next) => (req.method === 'GET' ? next() : limit('write', 120, 60_000)(req, res, next)));
api.use(auditWrites); // every write → audit trail
api.use('/admin', admin); // OmniChat Bot account only

// The dashboard reports which page is open, and its own JavaScript errors (both show up in the admin panel).
api.post('/activity', limit('activity', 60, 60_000), ah(async (req, res) => {
  const b = req.body || {};
  if (b.type === 'error') await issue(req, { uid: req.user.id, kind: 'browser', message: String(b.message || 'Unknown error').slice(0, 500), where: String(b.where || '').slice(0, 300) });
  else await recordPage(req, req.user.id, String(b.page || ''));
  res.json({ ok: true });
}));

api.get('/me', ah(async (req, res) => {
  await ensureDefaultWidgets(req.user.id);
  const u = await getUser(req.user.id);
  const widgets = (await Promise.all((u.widgets || []).map((id) => db.get(`widget/${id}`)))).filter(Boolean).map(widgetOut);
  res.json({
    user: { id: u.id, name: u.name, avatar: u.avatar, createdAt: u.createdAt, historyDays: u.historyDays ?? 7, sessions: sessionCount(u), isAdmin: isBotAccount(u) },
    accounts: Object.values(u.accounts || {}).map(publicAccount), widgets, providers: providersConfigured(), appUrl: config.appUrl,
  });
}));

api.get('/poll', limit('poll', 240, 60_000), ah(async (req, res) => {
  const live = await tick(req.user);
  const ev = await readEvents(req.user.id, num(req.query.c));
  const lc = num(req.query.l);
  const lg = await readLogs(req.user.id, { cursor: lc === undefined ? Number.MAX_SAFE_INTEGER : lc, limit: 50 });
  const donations = (await readDonations(req.user.id)) || [];
  res.json({ ...ev, state: publicState(live, req.user), logs: lc === undefined ? [] : lg.rows.reverse(), logCursor: lg.cursor, donations });
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
  setCookies(res, [await destroySession(req), clearLastLogin(req)]);
  req.noAudit = true;
  await forgetTickets(req.user.id).catch((e) => console.error('[support] forget', e.message)); // never blocks the deletion (tickets expire anyway)
  await deleteUser(req.user.id);
  await forgetUser(req.user.id).catch((e) => console.error('[audit] forget', e.message)); // the account itself is already gone
  await record(null, { kind: 'account', action: 'An account was deleted by its owner' }); // no name, no IP
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
  req.auditDetail = `${w.type}: ${w.name}`;
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

// â”€â”€ Egg Bot â”€â”€
api.get('/eggs', ah(async (req, res) => {
  const [doc, live, sharedBot, kickBot, channelId] = await Promise.all([readEggs(req.user.id), db.get(`live/${req.user.id}`), getSystemBot(), getSystemKickBot(), getEggChannelId()]);
  const yt = live?.youtube || {};
  const isBot = isBotAccount(req.user);
  res.json({
    settings: eggSettings(req.user),
    items: doc.items,
    seen: boardList(doc),
    events: (doc.events || []).slice(0, 20),
    rarities: [...new Set(doc.items.map((e) => e.rarity).filter(Boolean))],
    status: {
      feedReady: !!(config.discord.botToken && channelId && !doc.error && doc.lastCheckAt),
      feedError: doc.error || null,
      lastCheckAt: doc.lastCheckAt || null,
      youtubeConnected: !!req.user.accounts?.youtube,
      youtubeBot: sharedBot ? { channelName: sharedBot.channelName, avatar: sharedBot.avatar } : null,
      youtubeBotReady: youtubeBotReady(req.user, sharedBot),
      ytLive: !!(yt.live && yt._chatId),
      kickConnected: !!req.user.accounts?.kick,
      kickChatReady: !!(kickBot?.scope && String(kickBot.scope).split(/\s+/).includes('chat:write')),
      kickBot: kickBot ? { channelName: kickBot.channelName, avatar: kickBot.avatar } : null,
      kickLive: !!live?.kick?.live,
      postedToday: doc.posted?.day === new Date().toISOString().slice(0, 10) ? doc.posted.n : 0,
      dailyLimit: config.eggs.dailyPostLimit,
      isBot,
      // Bot-account-only details (the OmniChat Bot manages the shared setup)
      ...(isBot ? { channelId, discordConfigured: !!config.discord.botToken } : {}),
    },
  });
}));

api.put('/eggs/settings', ah(async (req, res) => {
  const b = req.body || {};
  const cur = eggSettings(req.user);
  const next = { ...cur };
  for (const k of ['enabled', 'commandEnabled', 'youtube', 'kick', 'events']) if (b[k] !== undefined) next[k] = !!b[k];
  if (b.rarities !== undefined) {
    if (!Array.isArray(b.rarities)) return res.status(400).json({ error: 'rarities must be a list' });
    next.rarities = [...new Set(b.rarities.map(String).filter((r) => /^[A-Za-z]{1,20}$/.test(r)))].slice(0, 20);
  }
  delete next.channelId;
  await updateUser(req.user.id, (u) => ({ ...u, egg: next }));
  const changes = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
  const changed = changes.map((k) => `${k}=${Array.isArray(next[k]) ? next[k].join('/') || 'all' : next[k] ? 'ON' : 'OFF'}`).join(', ');
  req.auditDetail = changed || undefined;
  if (changed) await log(req.user.id, 'info', 'eggs', `Egg Bot: ${changed}`);
  res.json({ ok: true, settings: next });
}));

// OmniChat Bot account only: the Discord channel every streamer's Egg Bot reads.
api.put('/eggs/channel', ah(async (req, res) => {
  if (!isBotAccount(req.user)) return res.status(403).json({ error: 'Only the OmniChat Bot account can change this' });
  const id = String(req.body?.channelId || '').trim();
  if (!/^\d{15,25}$/.test(id)) return res.status(400).json({ error: 'Channel ID must be the long number from Discord (Copy Channel ID)' });
  await setEggChannelId(id);
  await db.update('eggs/global', (G) => { G._nextAt = 0; return G; }, {});
  await log(req.user.id, 'info', 'eggs', `Egg channel set to ${id}`);
  res.json({ ok: true, channelId: id });
}));

api.post('/eggs/test', ah(async (req, res) => {
  const [live, feed, sharedBot, kickBot] = await Promise.all([db.get(`live/${req.user.id}`), readFeed(), getSystemBot(), getSystemKickBot()]);
  const yt = live?.youtube || {};
  const es = eggSettings(req.user);
  const text = feed.items[0] ? formatEgg(feed.items[0]) : '🥚 OmniChat Egg Bot is connected!';
  const result = {};
  if (es.youtube === false) result.youtube = 'disabled';
  else if (!req.user.accounts?.youtube) result.youtube = 'not connected';
  else if (youtubeBotReady(req.user, sharedBot) && yt.live && yt._chatId) {
    try { await postChat(req.user.id, yt._chatId, text); result.youtube = 'sent'; } catch (e) { result.youtube = e.message; }
  } else result.youtube = !youtubeBotReady(req.user, sharedBot) ? 'the OmniChat Bot is being set up' : 'go live on YouTube first';
  if (es.kick === false) result.kick = 'disabled';
  else if (!req.user.accounts?.kick) result.kick = 'not connected';
  else if (kickBot?.scope && String(kickBot.scope).split(/\s+/).includes('chat:write')) {
    const kickAcc = listAccounts(req.user, 'kick')[0];
    if (!kickAcc?.channelId) result.kick = 'not connected';
    else { try { await postKickChat(kickAcc.channelId, text); result.kick = 'sent'; } catch (e) { result.kick = e.message; } }
  } else result.kick = 'connect the OmniChat Kick bot account (chat:write)';
  await log(req.user.id, 'info', 'eggs', `Test message → YouTube: ${result.youtube} · Kick: ${result.kick}`);
  res.json({ ok: true, text, result });
}));

// ── Live tools: highlight, poll, commands/timers, stream summary ──
api.get('/tools', ah(async (req, res) => {
  res.json({ settings: toolSettings(req.user), poll: publicPoll(await readPoll(req.user.id)) });
}));
api.post('/tools/highlight', ah(async (req, res) => {
  const id = String(req.body?.id || '').slice(0, 120);
  if (!id) return res.status(400).json({ error: 'Missing message id' });
  const msg = await highlightMessage(req.user.id, id);
  res.json({ ok: true, id: msg.id });
}));
api.post('/media', express.raw({ type: () => true, limit: MAX_BYTES + 1024 }), ah(async (req, res) => {
  const want = req.query.kind === 'audio' ? 'audio' : req.query.kind === 'image' ? 'image' : null;
  const out = await saveMedia(req.user.id, req.body, want);
  await log(req.user.id, 'info', 'system', `Uploaded ${out.type} (${Math.round(out.size / 1024)} KB)`);
  res.json(out);
}));
api.delete('/media/:id([\\w-]{8,40})', ah(async (req, res) => res.json({ ok: await deleteMedia(req.user.id, req.params.id) })));
api.get('/tools/donate', ah(async (req, res) => {
  res.json({ settings: donateSettings(req.user), items: await readDonations(req.user.id), page: `${config.appUrl}/d/${req.user.id}` });
}));
api.put('/tools/donate', ah(async (req, res) => {
  const next = validateDonate(req.body || {}, donateSettings(req.user));
  await updateUser(req.user.id, (u) => ({ ...u, donate: next }));
  await log(req.user.id, 'info', 'system', `Donations ${next.enabled ? 'ON' : 'OFF'}${next.upi ? ` (UPI ${next.upi})` : ''}`);
  res.json({ ok: true, settings: next });
}));
api.post('/tools/donate/:id([\\w-]{6,20})/confirm', ah(async (req, res) => {
  const d = await confirmDonation(req.user.id, req.user, req.params.id);
  await log(req.user.id, 'info', 'system', `Donation received: ₹${d.amount} from ${d.name}`);
  res.json({ ok: true });
}));
api.post('/tools/donate/manual', ah(async (req, res) => {
  const d = await addManualDonation(req.user.id, req.user, req.body || {});
  await log(req.user.id, 'info', 'system', `Donation added by hand: ₹${d.amount} from ${d.name}`);
  res.json({ ok: true });
}));
api.delete('/tools/donate/:id([\\w-]{6,20})', ah(async (req, res) => { await dismissDonation(req.user.id, req.params.id); res.json({ ok: true }); }));
api.post('/tools/test-alert', ah(async (req, res) => { await testAlert(req.user.id, String(req.body?.type || '')); res.json({ ok: true }); }));
api.delete('/tools/highlight', ah(async (req, res) => { await clearHighlight(req.user.id); res.json({ ok: true }); }));
api.post('/tools/poll', ah(async (req, res) => {
  const poll = await startPoll(req.user.id, req.body || {});
  await log(req.user.id, 'info', 'poll', `Poll started: ${poll.question}`);
  res.json({ ok: true, poll });
}));
api.post('/tools/poll/end', ah(async (req, res) => res.json({ ok: true, poll: await endPoll(req.user.id) })));
api.delete('/tools/poll', ah(async (req, res) => { await clearPoll(req.user.id); res.json({ ok: true }); }));
api.put('/tools/settings', ah(async (req, res) => {
  const next = validateTools(req.body || {}, toolSettings(req.user));
  await updateUser(req.user.id, (u) => ({ ...u, tools: next }));
  await log(req.user.id, 'info', 'bot', `Commands saved: ${next.commands.length} command(s), ${next.timers.length} timer(s)`);
  res.json({ ok: true, settings: next });
}));
api.get('/tools/summary', ah(async (req, res) => {
  const live = await db.get(`live/${req.user.id}`);
  const s = await summary(req.user.id, req.query.hours, live?.session || null);
  res.json({ ...s, historyOff: (req.user.historyDays ?? 7) === 0 });
}));

// ── Help & support: message + screenshots → ticket (admin panel) + e-mail ──
api.get('/support', ah(async (req, res) => {
  const mine = await listTickets((x) => x.uid === req.user.id, 10);
  res.json({
    email: config.support.email || null, mail: mailReady(), categories: CATEGORIES,
    tickets: mine.map((t) => ({ id: t.id, ts: t.ts, category: t.category, message: t.message.slice(0, 160), status: t.status, shots: (t.shots || []).length })),
  });
}));
api.post('/support/shot', limit('shot', 20, 3_600_000), express.raw({ type: () => true, limit: SHOT_BYTES + 1024 }), ah(async (req, res) => {
  req.noAudit = true;
  res.json(await saveShot(req.user.id, req.body));
}));
api.post('/support', ah(async (req, res) => {
  const t = await createTicket(req, req.user, req.body || {});
  res.json({ ok: true, id: t.id, mailed: t.mail === 'sent' });
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

// Errors â†’ JSON (no stack traces to clients).
// eslint-disable-next-line no-unused-vars
app.use(async (err, req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  // The user sees a short reference; the admin panel (Issues) shows the details for it.
  const ref = randomId(6);
  const stack = String(err.stack || '').split('\n').slice(1, 4).map((l) => l.trim().replace(/\(?(?:file:\/\/)?\/\S*\/(?=(?:server|api|public|node_modules)\/)/, '(')).join(' < ');
  const uid = req.user?.id || req._user?.id;
  const path = req.originalUrl.split('?')[0].replace(/\/(w|widgets|media|donate)\/[\w-]{6,40}/, '/$1/:id'); // widget ids are secrets
  // Public pages (overlays, donation page) are opened by viewers: their IP is never recorded.
  await issue(uid ? req : null, { uid, kind: 'server', message: err.message, where: `${req.method} ${path} ${stack}`, ref, dedupeMs: 60_000 });
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.status ? err.message : `Server error (ref ${ref})` });
});

export default app;

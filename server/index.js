import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, randomId, prune } from './db.js';
import { log } from './logger.js';
import { getHub, peekHub, heartbeat, dropHub, dropWidgetClients } from './hub.js';
import { normalizeSettings } from '../public/js/settings.js';
import { verifyKickWebhook, handleKickWebhook } from './providers/kick.js';
import {
  authorizeUrl, handleCallback, currentUser, createSession, destroySession,
  providersConfigured, publicAccount, ensureDefaultWidgets, redirectUri,
  destroyAllSessions, sessionCount, setStateCookie, clearStateCookie, stateCookieName,
  parseCookies, revokeAccount, deleteUser,
} from './auth.js';

const PUBLIC = path.join(config.root, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};
const PROVIDERS = ['youtube', 'kick'];
const WIDGET_TYPES = ['chat', 'stats'];

// ── Security ───────────────────────────────────────────────────────────
const HTTPS = config.appUrl.startsWith('https://');
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  // kick.com: the streamer's own browser reads their public channel info (followers, ids) for auto-sync.
  "connect-src 'self' https://kick.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function securityHeaders(res, { embeddable = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // Widgets must load inside OBS / overlay apps / iframes; the dashboard must not be framed (clickjacking).
  res.setHeader('Content-Security-Policy', CSP + (embeddable ? '' : "; frame-ancestors 'none'") + (HTTPS ? '; upgrade-insecure-requests' : ''));
  res.setHeader('Cross-Origin-Resource-Policy', embeddable ? 'cross-origin' : 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (!embeddable) res.setHeader('X-Frame-Options', 'DENY');
  if (HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Fixed-window rate limiter (in memory, per IP + bucket).
const hits = new Map();
function rateLimited(req, bucket, max, windowMs) {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now > h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n += 1;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60_000).unref();

// Cap concurrent SSE streams per IP (stops someone exhausting sockets).
const sseCount = new Map();
function sseAllowed(req, res) {
  const ip = clientIp(req);
  const n = sseCount.get(ip) || 0;
  if (n >= config.maxSsePerIp) return false;
  sseCount.set(ip, n + 1);
  res.on('close', () => { const m = (sseCount.get(ip) || 1) - 1; m > 0 ? sseCount.set(ip, m) : sseCount.delete(ip); });
  return true;
}

// ── helpers ────────────────────────────────────────────────────────────
function sendFile(res, rel, { noStore = false } = {}) {
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return notFound(res);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': noStore ? 'no-store' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const notFound = (res) => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); };
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

function readRaw(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readJson(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
}

// Basic CSRF protection for state-changing API calls.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host || origin === config.appUrl; } catch { return false; }
}

const widgetRow = (w) => ({ id: w.id, type: w.type, name: w.name, settings: JSON.parse(w.settings || '{}'), updatedAt: w.updated_at });

const cleanName = (v) => String(v ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60);

// ── routes ─────────────────────────────────────────────────────────────
async function route(req, res) {
  const url = new URL(req.url, config.appUrl);
  let p;
  try { p = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'; } catch { return notFound(res); }
  const method = req.method;
  const isWidget = /^\/(w\/|api\/w\/|demo$|css\/|js\/|favicon)/.test(p);
  securityHeaders(res, { embeddable: isWidget });

  if (p.startsWith('/auth/') && rateLimited(req, 'auth', 30, 60_000)) return json(res, 429, { error: 'Too many login attempts, try again in a minute' });
  if (p.startsWith('/api/') && method !== 'GET' && rateLimited(req, 'write', 120, 60_000)) return json(res, 429, { error: 'Too many requests' });
  if ((p === '/api/events' || /^\/api\/w\/[^/]+\/events$/.test(p)) && !sseAllowed(req, res)) return json(res, 429, { error: 'Too many open connections' });

  // ── OAuth ──
  let m = p.match(/^\/auth\/(youtube|kick)$/);
  if (m && method === 'GET') {
    const provider = m[1];
    if (!providersConfigured()[provider]) return redirect(res, `/login?error=${encodeURIComponent(`${provider} login is not configured on this server`)}`);
    const user = currentUser(req);
    const { url: to, state } = authorizeUrl(provider, user?.id);
    setStateCookie(res, state);
    return redirect(res, to);
  }
  m = p.match(/^\/auth\/(youtube|kick)\/callback$/);
  if (m && method === 'GET') {
    const user = currentUser(req);
    try {
      const cookieState = parseCookies(req)[stateCookieName];
      clearStateCookie(res);
      const { userId, linked } = await handleCallback(m[1], url.searchParams, cookieState);
      if (!linked || !user) createSession(res, userId);
      return redirect(res, linked ? '/#connections' : '/');
    } catch (e) {
      log(user?.id ?? null, 'error', 'auth', `${m[1]} login failed: ${e.message}`);
      return redirect(res, `${user ? '/?error=' : '/login?error='}${encodeURIComponent(e.message)}${user ? '#connections' : ''}`);
    }
  }
  if (p === '/auth/logout' && method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Bad origin' });
    destroySession(req, res);
    return json(res, 200, { ok: true });
  }
  if (p === '/auth/logout-all' && method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Bad origin' });
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Not logged in' });
    destroyAllSessions(user.id, res);
    log(user.id, 'info', 'auth', 'Signed out from all devices');
    return json(res, 200, { ok: true });
  }

  // ── Kick webhooks (signed by Kick, verified with its public key) ──
  if (p === '/webhooks/kick' && method === 'POST') {
    if (rateLimited(req, 'webhook', 600, 60_000)) return json(res, 429, { error: 'Too many requests' });
    const raw = await readRaw(req, 1_000_000);
    if (!(await verifyKickWebhook(req.headers, raw))) {
      log(null, 'warn', 'kick', 'Rejected webhook with invalid signature');
      return json(res, 401, { error: 'Invalid signature' });
    }
    let payload;
    try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
    handleKickWebhook(String(req.headers['kick-event-type'] || ''), payload, String(req.headers['kick-event-message-id']), getHub);
    return json(res, 200, { ok: true });
  }

  // ── Public widget endpoints (no login — used by OBS / overlay tools) ──
  m = p.match(/^\/w\/([\w-]{6,40})$/);
  if (m && method === 'GET') return sendFile(res, 'widget.html');
  m = p.match(/^\/api\/w\/([\w-]{6,40})(\/events)?$/);
  if (m && method === 'GET') {
    const w = db.prepare('SELECT * FROM widgets WHERE id = ?').get(m[1]);
    if (!w) return json(res, 404, { error: 'Widget not found' });
    if (!m[2]) return json(res, 200, { id: w.id, type: w.type, settings: JSON.parse(w.settings || '{}') });
    sse(res);
    return getHub(w.user_id).addClient(res, { kind: 'widget', widgetId: w.id });
  }

  // ── Pages ──
  if (p === '/login' && method === 'GET') {
    if (currentUser(req)) return redirect(res, '/');
    return sendFile(res, 'login.html', { noStore: true });
  }
  if (p === '/' && method === 'GET') {
    if (!currentUser(req)) return redirect(res, '/login');
    return sendFile(res, 'index.html', { noStore: true });
  }
  if (p === '/demo' && method === 'GET') return sendFile(res, 'widget.html');

  // ── Public config ──
  if (p === '/api/providers' && method === 'GET') return json(res, 200, providersConfigured());

  // ── Authenticated API ──
  if (p.startsWith('/api/')) {
    const user = currentUser(req);
    if (!user) return json(res, 401, { error: 'Not logged in' });
    if (method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Bad origin' });
    const uid = user.id;

    if (p === '/api/me' && method === 'GET') {
      ensureDefaultWidgets(uid);
      const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(uid).map(publicAccount);
      const widgets = db.prepare('SELECT * FROM widgets WHERE user_id = ? ORDER BY created_at').all(uid).map(widgetRow);
      return json(res, 200, {
        user: { id: uid, name: user.name, avatar: user.avatar, createdAt: user.created_at, historyDays: user.history_days ?? 7, sessions: sessionCount(uid) },
        accounts, widgets, providers: providersConfigured(), appUrl: config.appUrl,
      });
    }

    if (p === '/api/me/settings' && method === 'PUT') {
      const body = await readJson(req);
      const days = Number(body.historyDays);
      if (![0, 1, 7, 30].includes(days)) return json(res, 400, { error: 'historyDays must be 0, 1, 7 or 30' });
      db.prepare('UPDATE users SET history_days = ? WHERE id = ?').run(days, uid);
      if (days === 0) db.prepare('DELETE FROM messages WHERE user_id = ?').run(uid);
      else db.prepare('DELETE FROM messages WHERE user_id = ? AND ts < ?').run(uid, Date.now() - days * 86_400_000);
      const h = peekHub(uid);
      if (h) h.historyDays = days;
      log(uid, 'info', 'system', days ? `Chat history retention set to ${days} day(s)` : 'Chat history saving turned off');
      return json(res, 200, { ok: true, historyDays: days });
    }

    if (p === '/api/me' && method === 'DELETE') {
      const body = await readJson(req);
      if (body.confirm !== 'DELETE') return json(res, 400, { error: 'Type DELETE to confirm' });
      dropHub(uid);
      await deleteUser(uid);
      addSetCookieClear(res);
      console.log(`[auth] user ${uid} deleted their account`);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/messages' && method === 'DELETE') {
      db.prepare('DELETE FROM messages WHERE user_id = ?').run(uid);
      log(uid, 'info', 'system', 'Chat history cleared');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/events' && method === 'GET') {
      sse(res);
      return getHub(uid).addClient(res, { kind: 'dashboard' });
    }

    m = p.match(/^\/api\/accounts\/(youtube|kick)$/);
    if (m && method === 'DELETE') {
      const n = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').get(uid).n;
      if (n <= 1) return json(res, 400, { error: 'You need at least one connected account to log in. Connect the other platform first.' });
      const acc = db.prepare('SELECT * FROM accounts WHERE user_id = ? AND provider = ?').get(uid, m[1]);
      if (acc) await revokeAccount(acc);
      db.prepare('DELETE FROM accounts WHERE user_id = ? AND provider = ?').run(uid, m[1]);
      log(uid, 'info', 'auth', `${m[1]} disconnected`);
      peekHub(uid)?.restart();
      return json(res, 200, { ok: true });
    }

    // Sync Kick ids/followers from the channel JSON the user pasted (kick.com/api/v2/channels/<slug>).
    if ((p === '/api/accounts/kick/sync' || p === '/api/accounts/kick/chatroom') && method === 'PUT') {
      const body = await readJson(req);
      const toInt = (v) => {
        if (v === undefined || v === null || String(v).trim() === '') return undefined;
        const n = Number(String(v).trim());
        return Number.isInteger(n) && n >= 0 && n < 1e12 ? n : NaN;
      };
      const vals = { kick_chatroom_id: toInt(body.chatroomId), kick_channel_id: toInt(body.channelId), kick_followers: toInt(body.followers) };
      if (Object.values(vals).some((v) => Number.isNaN(v))) return json(res, 400, { error: 'Values must be numbers' });
      const sets = Object.entries(vals).filter(([, v]) => v !== undefined);
      if (!sets.length) return json(res, 400, { error: 'Nothing to save — paste the page text or a chatroom ID' });
      const before = db.prepare("SELECT * FROM accounts WHERE user_id = ? AND provider = 'kick'").get(uid);
      if (!before) return json(res, 400, { error: 'Connect Kick first' });
      const changed = sets.filter(([k, v]) => before[k] !== v);
      if (changed.length) {
        db.prepare(`UPDATE accounts SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...sets.map(([, v]) => v), Date.now(), before.id);
        log(uid, 'info', 'kick', `${body.auto ? 'Auto-synced' : 'Synced'} from Kick: ${changed.map(([k, v]) => `${k.replace('kick_', '')}=${v}`).join(', ')}`);
        const idsChanged = changed.some(([k]) => k !== 'kick_followers');
        const h = getHub(uid);
        if (idsChanged) h.restart(); // reconnect sockets with the new ids
        else {
          const f = vals.kick_followers;
          if (f !== undefined) { if (h.watchers.kick) h.watchers.kick.account.kick_followers = f; h.update('kick', { followers: f }); }
        }
      }
      const acc = db.prepare("SELECT * FROM accounts WHERE user_id = ? AND provider = 'kick'").get(uid);
      return json(res, 200, { ok: true, account: publicAccount(acc), chatroomId: acc.kick_chatroom_id });
    }

    if (p === '/api/watchers/restart' && method === 'POST') {
      getHub(uid).restart();
      log(uid, 'info', 'system', 'Watchers restarted from dashboard');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/widgets' && method === 'POST') {
      const body = await readJson(req);
      const type = WIDGET_TYPES.includes(body.type) ? body.type : 'chat';
      const count = db.prepare('SELECT COUNT(*) AS n FROM widgets WHERE user_id = ?').get(uid).n;
      if (count >= 50) return json(res, 400, { error: 'Widget limit reached (50)' });
      const id = randomId();
      const now = Date.now();
      db.prepare('INSERT INTO widgets (id, user_id, type, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, uid, type, cleanName(body.name) || `New ${type} widget`, JSON.stringify(normalizeSettings(body.settings)), now, now);
      return json(res, 200, widgetRow(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id)));
    }
    m = p.match(/^\/api\/widgets\/([\w-]{6,40})\/rotate$/);
    if (m && method === 'POST') {
      const w = db.prepare('SELECT * FROM widgets WHERE id = ? AND user_id = ?').get(m[1], uid);
      if (!w) return json(res, 404, { error: 'Widget not found' });
      const id = randomId();
      db.prepare('UPDATE widgets SET id = ?, updated_at = ? WHERE id = ?').run(id, Date.now(), w.id);
      dropWidgetClients(uid, w.id);
      log(uid, 'info', 'system', `Widget "${w.name}" got a new URL (old URL disabled)`);
      return json(res, 200, widgetRow(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id)));
    }
    m = p.match(/^\/api\/widgets\/([\w-]{6,40})$/);
    if (m) {
      const w = db.prepare('SELECT * FROM widgets WHERE id = ? AND user_id = ?').get(m[1], uid);
      if (!w) return json(res, 404, { error: 'Widget not found' });
      if (method === 'PUT') {
        const body = await readJson(req);
        const name = body.name !== undefined ? cleanName(body.name) || w.name : w.name;
        const settings = body.settings !== undefined ? JSON.stringify(normalizeSettings(body.settings)) : w.settings;
        db.prepare('UPDATE widgets SET name = ?, settings = ?, updated_at = ? WHERE id = ?').run(name, settings, Date.now(), w.id);
        peekHub(uid)?.widgetSettings(w.id, { settings: JSON.parse(settings) }); // live-update open overlays
        return json(res, 200, widgetRow(db.prepare('SELECT * FROM widgets WHERE id = ?').get(w.id)));
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM widgets WHERE id = ?').run(w.id);
        dropWidgetClients(uid, w.id);
        return json(res, 200, { ok: true });
      }
    }

    if (p === '/api/logs' && method === 'GET') {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
      const level = url.searchParams.get('level');
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      const where = ['user_id = ?'];
      const args = [uid];
      if (['info', 'warn', 'error'].includes(level)) { where.push('level = ?'); args.push(level); }
      if (q) { where.push('(message LIKE ? OR source LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
      const rows = db.prepare(`SELECT id, ts, level, source, message FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, limit);
      return json(res, 200, rows);
    }
    if (p === '/api/logs' && method === 'DELETE') {
      db.prepare('DELETE FROM logs WHERE user_id = ?').run(uid);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/messages' && method === 'GET') {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      const platform = url.searchParams.get('platform');
      const where = ['user_id = ?'];
      const args = [uid];
      if (q) { where.push('(author LIKE ? OR text LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
      if (PROVIDERS.includes(platform)) { where.push('platform = ?'); args.push(platform); }
      const rows = db.prepare(`SELECT id, platform, ts, kind, author, text, deleted FROM messages WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, limit);
      const stats = db.prepare('SELECT platform, COUNT(*) AS n FROM messages WHERE user_id = ? AND ts > ? GROUP BY platform').all(uid, Date.now() - 86_400_000);
      return json(res, 200, { rows, last24h: stats });
    }

    return json(res, 404, { error: 'Unknown endpoint' });
  }

  // ── Static assets ──
  if (method === 'GET' && /^\/(css|js|img)\/|^\/favicon\.svg$/.test(p)) return sendFile(res, p);
  return notFound(res);
}

function addSetCookieClear(res) {
  destroySession({ headers: {} }, res); // just clears the cookie in the browser
}

const server = http.createServer({ maxHeaderSize: 16_384 }, (req, res) => {
  route(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    else res.end();
  });
});

// Slow-client protection (SSE streams are long-lived, so no overall request timeout).
server.headersTimeout = 15_000;
server.requestTimeout = 0;
server.keepAliveTimeout = 5_000;

setInterval(heartbeat, 20_000);
prune();
setInterval(prune, 6 * 3_600_000);

server.listen(config.port, () => {
  const p = providersConfigured();
  console.log(`\n  OmniChat → ${config.appUrl}`);
  console.log(`  Database → ${path.join(config.dataDir, 'omnichat.db')}`);
  console.log(`  YouTube login: ${p.youtube ? 'ready' : 'NOT configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'}  → redirect URI: ${redirectUri('youtube')}`);
  console.log(`  Kick login:    ${p.kick ? 'ready' : 'NOT configured (KICK_CLIENT_ID / KICK_CLIENT_SECRET)'}  → redirect URI: ${redirectUri('kick')}`);
  const pub = config.publicUrl.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(config.publicUrl);
  console.log(`  Kick chat:     ${pub ? `automatic via webhooks → set Kick app Webhook URL to ${config.publicUrl}/webhooks/kick` : 'manual Chatroom ID (set PUBLIC_URL to a public https URL for automatic webhooks)'}\n`);
  log(null, 'info', 'system', 'Server started');
});

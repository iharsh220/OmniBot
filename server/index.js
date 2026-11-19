import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, randomId, prune } from './db.js';
import { log } from './logger.js';
import { getHub, peekHub, heartbeat } from './hub.js';
import { verifyKickWebhook, handleKickWebhook } from './providers/kick.js';
import {
  authorizeUrl, handleCallback, currentUser, createSession, destroySession,
  providersConfigured, publicAccount, ensureDefaultWidgets, redirectUri,
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
  "connect-src 'self'",
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
  res.setHeader('Content-Security-Policy', CSP + (embeddable ? '' : "; frame-ancestors 'none'"));
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
function sendFile(res, rel) {
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return notFound(res);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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

function cleanSettings(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!/^[a-zA-Z]{1,40}$/.test(k)) continue;
    if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  }
  return out;
}

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
    return redirect(res, authorizeUrl(provider, user?.id));
  }
  m = p.match(/^\/auth\/(youtube|kick)\/callback$/);
  if (m && method === 'GET') {
    const user = currentUser(req);
    try {
      const { userId, linked } = await handleCallback(m[1], url.searchParams);
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
    return sendFile(res, 'login.html');
  }
  if (p === '/' && method === 'GET') {
    if (!currentUser(req)) return redirect(res, '/login');
    return sendFile(res, 'index.html');
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
        user: { id: uid, name: user.name, avatar: user.avatar, createdAt: user.created_at },
        accounts, widgets, providers: providersConfigured(), appUrl: config.appUrl,
      });
    }

    if (p === '/api/events' && method === 'GET') {
      sse(res);
      return getHub(uid).addClient(res, { kind: 'dashboard' });
    }

    m = p.match(/^\/api\/accounts\/(youtube|kick)$/);
    if (m && method === 'DELETE') {
      const n = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').get(uid).n;
      if (n <= 1) return json(res, 400, { error: 'You need at least one connected account to log in. Connect the other platform first.' });
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
      const r = db.prepare(`UPDATE accounts SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE user_id = ? AND provider = 'kick'`)
        .run(...sets.map(([, v]) => v), Date.now(), uid);
      if (!r.changes) return json(res, 400, { error: 'Connect Kick first' });
      log(uid, 'info', 'kick', `Synced from Kick page: ${sets.map(([k, v]) => `${k.replace('kick_', '')}=${v}`).join(', ')}`);
      getHub(uid).restart();
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
        .run(id, uid, type, String(body.name || `New ${type} widget`).slice(0, 60), JSON.stringify(cleanSettings(body.settings)), now, now);
      return json(res, 200, widgetRow(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id)));
    }
    m = p.match(/^\/api\/widgets\/([\w-]{6,40})$/);
    if (m) {
      const w = db.prepare('SELECT * FROM widgets WHERE id = ? AND user_id = ?').get(m[1], uid);
      if (!w) return json(res, 404, { error: 'Widget not found' });
      if (method === 'PUT') {
        const body = await readJson(req);
        const name = body.name !== undefined ? String(body.name).slice(0, 60) || w.name : w.name;
        const settings = body.settings !== undefined ? JSON.stringify(cleanSettings(body.settings)) : w.settings;
        db.prepare('UPDATE widgets SET name = ?, settings = ?, updated_at = ? WHERE id = ?').run(name, settings, Date.now(), w.id);
        peekHub(uid)?.widgetSettings(w.id, { settings: JSON.parse(settings) }); // live-update open overlays
        return json(res, 200, widgetRow(db.prepare('SELECT * FROM widgets WHERE id = ?').get(w.id)));
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM widgets WHERE id = ?').run(w.id);
        return json(res, 200, { ok: true });
      }
    }

    if (p === '/api/logs' && method === 'GET') {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
      const level = url.searchParams.get('level');
      const rows = level
        ? db.prepare('SELECT * FROM logs WHERE user_id = ? AND level = ? ORDER BY id DESC LIMIT ?').all(uid, level, limit)
        : db.prepare('SELECT * FROM logs WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(uid, limit);
      return json(res, 200, rows);
    }
    if (p === '/api/logs' && method === 'DELETE') {
      db.prepare('DELETE FROM logs WHERE user_id = ?').run(uid);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/messages' && method === 'GET') {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
      const q = (url.searchParams.get('q') || '').trim();
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

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    else res.end();
  });
});

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

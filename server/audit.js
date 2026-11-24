// Audit trail for the admin panel (OmniChat Bot account): who signed in, from where, what they did, what broke.
//
//   audit/{uid}   list  sign-ins and actions of one user (newest first)
//   pages/{uid}   list  dashboard pages one user opened
//   audit/all     list  sign-ins and actions of everyone
//   audit/issues  list  failed sign-ins, server/browser errors, platform errors
//   seen/{uid}    doc   last activity + recent IPs / devices
//
// Kept AUDIT_DAYS days (stated in privacy.html). Never stored here: tokens, cookies, request bodies, chat text.
// Recording is best effort: nothing in this file may ever break or noticeably slow down a request.
import * as db from './store.js';
import { randomId } from './crypto.js';

export const AUDIT_DAYS = 90;
const DAY = 86_400_000;
const TTL = AUDIT_DAYS * 86_400;
const MAX = { user: 1000, pages: 200, all: 3000, issues: 1000 };
export const PAGES = ['overview', 'studio', 'tools', 'donations', 'connections', 'eggs', 'logs', 'settings', 'support'];

// ── Who is calling ──
const clean = (v, n = 80) => String(v ?? '').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const decode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

/** Client IP. Vercel sets x-real-ip itself (clients can't spoof it there); elsewhere only the socket is trusted. */
export function clientIp(req) {
  const h = req.headers || {};
  const raw = process.env.VERCEL ? h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] : req.socket?.remoteAddress;
  const ip = clean(raw, 45).replace(/^::ffff:/, '');
  return ip === '::1' ? '127.0.0.1' : ip || null;
}
/** Approximate location from Vercel's own IP headers (no third-party lookup, city level at best). */
export function clientLocation(req) {
  if (!process.env.VERCEL) return null;
  const h = req.headers || {};
  const loc = {
    city: clean(decode(h['x-vercel-ip-city'] || '')), region: clean(h['x-vercel-ip-country-region'], 10),
    country: clean(h['x-vercel-ip-country'], 4), tz: clean(h['x-vercel-ip-timezone'], 40),
  };
  return loc.country || loc.city ? loc : null;
}
/** "Chrome 130 · Windows · Desktop" from the user agent. */
export function clientDevice(req) {
  const ua = String(req.headers?.['user-agent'] || '');
  if (!ua) return null;
  const find = (list) => { for (const [name, re] of list) { const m = ua.match(re); if (m) return m[1] ? `${name} ${m[1]}` : name; } return null; };
  const browser = find([['OBS', /\bOBS\/(\d+)/], ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/], ['Opera', /OPR\/(\d+)/], ['Samsung Internet', /SamsungBrowser\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/], ['Chrome', /(?:Chrome|CriOS)\/(\d+)/], ['Safari', /Version\/(\d+).*Safari/]]) || 'Other browser';
  const os = find([['Windows', /Windows NT/], ['Android', /Android(?: (\d+))?/], ['iOS', /(?:iPhone|iPad|iPod)/], ['macOS', /Mac OS X/], ['ChromeOS', /CrOS/], ['Linux', /Linux/]]) || 'Other OS';
  const type = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? 'Tablet' : /Mobi|iPhone/i.test(ua) ? 'Mobile' : 'Desktop';
  return `${browser} · ${os} · ${type}`;
}
const client = (req) => (req ? { ip: clientIp(req), loc: clientLocation(req), device: clientDevice(req) } : {});

// ── Writing ──
const redact = (v) => String(v ?? '')
  .replace(/(Bearer\s+)\S+/gi, '$1[hidden]')
  .replace(/(\b(?:access_token|refresh_token|id_token|client_secret|code|token|key)["']?\s*[=:]\s*["']?)[^\s&"',}]+/gi, '$1[hidden]');
const text = (v, n = 300) => clean(redact(v), n) || undefined;

// Same thing again within the window is recorded once (Studio autosave, repeated errors). Per instance.
const recent = new Map();
function repeated(key, ms) {
  const now = Date.now();
  if ((recent.get(key) || 0) > now) return true;
  recent.set(key, now + ms);
  if (recent.size > 3000) for (const [k, t] of recent) if (t <= now) recent.delete(k);
  return false;
}
/** Wait for the write (a serverless function freezes after replying), but never longer than 1.5 s. */
async function safely(work) {
  let timer;
  try {
    await Promise.race([work, new Promise((r) => { timer = setTimeout(r, 1500); })]);
  } catch (e) { console.warn('[audit]', e.message); } finally { clearTimeout(timer); }
}
const write = (lists, item) => safely(db.pushMany(lists, item, { cutoff: Date.now() - AUDIT_DAYS * DAY, ttl: TTL }));

/** Something a user did (or tried to do). `kind`: auth, account, widget, eggs, tools, donate, media, settings. */
export async function record(req, { uid = null, kind, action, detail, ok = true, status, ms, dedupeMs = 0 }) {
  const item = { id: randomId(6), ts: Date.now(), uid, kind, action, detail: text(detail), ok, status, ms, ...client(req) };
  if (dedupeMs && repeated(`a|${uid}|${kind}|${action}|${item.detail}|${ok}|${item.ip}`, dedupeMs)) return;
  await write([...(uid ? [[`audit/${uid}`, MAX.user]] : []), ['audit/all', MAX.all]], item);
}
/** Something went wrong. `kind`: login, server, browser, youtube, kick, eggs, bot, access … */
export async function issue(req, { uid = null, level = 'error', kind, message, where, ref, dedupeMs = 10 * 60_000 }) {
  const item = { id: ref || randomId(6), ts: Date.now(), uid, level, kind, message: text(message, 500), where: text(where, 400), ...client(req) };
  if (repeated(`i|${uid}|${kind}|${item.message}|${item.ip || ''}`, dedupeMs)) return;
  await write([['audit/issues', MAX.issues]], item);
}
export async function recordPage(req, uid, page) {
  if (!PAGES.includes(page) || repeated(`p|${uid}|${page}`, 60_000)) return;
  await write([[`pages/${uid}`, MAX.pages]], { id: randomId(6), ts: Date.now(), uid, kind: 'page', action: 'Opened page', detail: page, ok: true, ...client(req) });
}

const seenDoc = (uid, fn) => safely((async () => {
  await db.update(`seen/${uid}`, fn, { ips: [] });
  await db.expire(`seen/${uid}`, TTL);
})());
/** Last activity + IP history (written at most every 5 min per user and IP). */
export async function markSeen(req, uid) {
  const c = client(req);
  if (repeated(`s|${uid}|${c.ip}`, 5 * 60_000)) return;
  const now = Date.now();
  await seenDoc(uid, (S) => {
    const ips = (S.ips || []).filter((x) => x.last > now - AUDIT_DAYS * DAY);
    const same = ips.find((x) => x.ip === c.ip && x.device === c.device);
    if (same) Object.assign(same, { last: now, loc: c.loc });
    else ips.push({ ...c, first: now, last: now });
    return { ...S, ...c, at: now, ips: ips.sort((a, b) => b.last - a.last).slice(0, 20) };
  });
}
/** An OBS widget of this user is being polled (time only: widget viewers' IPs are never stored). */
export async function markOverlay(uid) {
  if (repeated(`o|${uid}`, 5 * 60_000)) return;
  await seenDoc(uid, (S) => ({ ...S, overlayAt: Date.now() }));
}

/** Account deleted → nothing that identifies the user stays in the audit trail. */
export async function forgetUser(uid) {
  await Promise.all([`audit/${uid}`, `pages/${uid}`, `seen/${uid}`].map((k) => db.del(k)));
  await Promise.all(['audit/all', 'audit/issues'].map((k) => db.dropFromList(k, 'uid', uid)));
}

// ── Every write a signed-in user makes ──
const RULES = [
  ['PUT', /^\/me\/settings$/, 'settings', 'Changed chat history setting', (b) => `${Number(b.historyDays) || 0} day(s)`],
  ['DELETE', /^\/messages$/, 'settings', 'Cleared chat history'],
  ['DELETE', /^\/logs$/, 'settings', 'Cleared system logs'],
  ['POST', /^\/watchers\/restart$/, 'settings', 'Restarted watchers'],
  ['DELETE', /^\/accounts\/(youtube|kick)$/, 'account', 'Disconnected platform', (_b, m) => m[1]],
  ['PUT', /^\/accounts\/kick\//, 'account', 'Synced Kick followers'],
  ['POST', /^\/widgets$/, 'widget', 'Created widget', (b) => `${clean(b.type, 20)}: ${clean(b.name, 60)}`],
  ['POST', /^\/widgets\/[^/]+\/rotate$/, 'widget', 'Regenerated widget URL'],
  ['PUT', /^\/widgets\//, 'widget', 'Edited widget'],
  ['DELETE', /^\/widgets\//, 'widget', 'Deleted widget'],
  ['PUT', /^\/eggs\/settings$/, 'eggs', 'Changed Egg Bot settings'],
  ['PUT', /^\/eggs\/channel$/, 'eggs', 'Changed the Discord egg channel'],
  ['POST', /^\/eggs\/test$/, 'eggs', 'Sent an Egg Bot test message'],
  ['POST', /^\/tools\/highlight$/, 'tools', 'Highlighted a chat message'],
  ['DELETE', /^\/tools\/highlight$/, 'tools', 'Hid the highlight'],
  ['POST', /^\/tools\/test-alert$/, 'tools', 'Sent a test alert', (b) => clean(b.type, 30)],
  ['POST', /^\/tools\/poll$/, 'tools', 'Started a poll', (b) => clean(b.question, 100)],
  ['POST', /^\/tools\/poll\/end$/, 'tools', 'Ended the poll'],
  ['DELETE', /^\/tools\/poll$/, 'tools', 'Removed the poll'],
  ['PUT', /^\/tools\/settings$/, 'tools', 'Saved bot commands / timers', (b) => `${b.commands?.length || 0} command(s), ${b.timers?.length || 0} timer(s)`],
  ['PUT', /^\/tools\/donate$/, 'donate', 'Saved donation settings', (b) => (b.enabled ? 'ON' : 'OFF')],
  ['POST', /^\/tools\/donate\/manual$/, 'donate', 'Added a donation by hand'],
  ['POST', /^\/tools\/donate\/[^/]+\/confirm$/, 'donate', 'Confirmed a donation'],
  ['DELETE', /^\/tools\/donate\//, 'donate', 'Dismissed a donation'],
  ['POST', /^\/media$/, 'media', 'Uploaded a file'],
  ['DELETE', /^\/media\//, 'media', 'Deleted a file'],
  ['POST', /^\/support$/, 'support', 'Contacted support', (b) => clean(b.category, 40)],
];
/** Express middleware (after auth): records the action right before the JSON reply goes out. */
export function auditWrites(req, res, next) {
  if (req.method === 'GET' || req.path === '/activity' || req.path.startsWith('/admin')) return next();
  const { method, path } = req;
  const t0 = Date.now();
  const send = res.json.bind(res);
  res.json = (body) => {
    res.json = send;
    const auto = req.body?.auto && path.startsWith('/accounts/kick/'); // background sync, not a user action
    if (req.noAudit || auto) return send(body);
    const status = res.statusCode;
    const ok = status < 400;
    let rule; let m;
    for (const r of RULES) if (r[0] === method && (m = path.match(r[1]))) { rule = r; break; }
    const b = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    let detail = req.auditDetail;
    try { detail ??= rule?.[4]?.(b, m); } catch { /* odd body */ }
    if (!ok) detail = [detail, body?.error].filter(Boolean).join(' — ');
    record(req, { uid: req.user.id, kind: rule?.[2] || 'other', action: rule?.[3] || `${method} ${clean(path, 60)}`, detail, ok, status, ms: Date.now() - t0, dedupeMs: 2 * 60_000 })
      .finally(() => send(body));
    return res;
  };
  next();
}

// ── Reading (admin panel) ──
const fresh = (x) => x && x.ts > Date.now() - AUDIT_DAYS * DAY;
export const readList = async (key, start, n) => (await db.range(key, start, start + n - 1)).filter(fresh);
/** Newest first, filtered; scans in chunks so a narrow filter still finds older entries. */
export async function searchList(key, { max, offset = 0, limit = 100, match = () => true }) {
  const rows = [];
  let pos = offset;
  while (pos < max && rows.length < limit) {
    const chunk = await db.range(key, pos, Math.min(pos + 400, max) - 1);
    if (!chunk.length) return { rows, next: null };
    for (const x of chunk) {
      pos += 1;
      if (fresh(x) && match(x)) rows.push(x);
      if (rows.length >= limit) break;
    }
  }
  return { rows, next: pos < max && rows.length >= limit ? pos : null };
}
export const LIST_MAX = MAX;

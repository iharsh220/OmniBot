// Help & support: a signed-in streamer sends a message with screenshots. It is saved as a ticket (admin panel →
// Support) and e-mailed to the OmniChat support mailbox (SUPPORT_EMAIL) with the screenshots attached.
// Screenshots are private: only the admin can open them. Everything is deleted after TICKET_DAYS.
import nodemailer from 'nodemailer';
import * as db from './store.js';
import { config } from './config.js';
import { randomId } from './crypto.js';
import { sniff } from './media.js';
import { clientIp, clientLocation, clientDevice, issue } from './audit.js';

export const SHOT_BYTES = 3 * 1024 * 1024; // Vercel's request limit is 4.5 MB
export const TICKET_DAYS = 90;
export const CATEGORIES = ['Login / connection', 'Overlay / widget', 'Egg Bot / chat bot', 'Alerts / donations', 'Something else'];
const DAY = 86_400; // seconds
const TTL = TICKET_DAYS * DAY;
const CHUNK = 512 * 1024;
const MAX_SHOTS = 3;
const MAX_TICKETS = 500;
const PER_HOUR = 5;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
// keeps line breaks, drops other control characters
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, n);
const EMAIL_RE = /^[^\s@<>"',;:\\()[\]]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const SHOT_RE = /^[\w-]{8,40}$/;

// ── Screenshots ──
export async function saveShot(uid, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Empty file');
  if (buf.length > SHOT_BYTES) throw bad('Screenshot is too big (max 3 MB)', 413);
  const type = sniff(buf);
  if (!type?.startsWith('image/')) throw bad('Please pick a PNG, JPG, GIF or WebP screenshot', 415);
  const id = randomId(12);
  const chunks = Math.ceil(buf.length / CHUNK);
  const keep = async (k, v) => { await db.set(k, v); await db.expire(k, DAY); }; // not sent within a day → gone
  for (let i = 0; i < chunks; i++) await keep(`shot/${id}/${i}`, buf.subarray(i * CHUNK, (i + 1) * CHUNK).toString('base64'));
  await keep(`shot/${id}`, { uid, type, size: buf.length, chunks, ticket: null, createdAt: Date.now() });
  return { id, type, size: buf.length };
}
const shotKeys = (id, meta) => [`shot/${id}`, ...Array.from({ length: meta?.chunks || 0 }, (_, i) => `shot/${id}/${i}`)];
export async function readShot(id) {
  const meta = await db.get(`shot/${id}`);
  if (!meta) return null;
  const parts = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => db.get(`shot/${id}/${i}`)));
  if (parts.some((p) => typeof p !== 'string')) return null;
  return { ...meta, buf: Buffer.concat(parts.map((p) => Buffer.from(p, 'base64'))) };
}

// ── E-mail ──
export const mailReady = () => !!(config.support.email && config.support.smtpUser && config.support.smtpPass);
let testTransport = null;
/** Tests only: use a fake transport. */
export const setTransport = (t) => { testTransport = t; };
const transport = () => testTransport || nodemailer.createTransport({
  host: config.support.smtpHost, port: config.support.smtpPort, secure: config.support.smtpPort === 465, requireTLS: true,
  auth: { user: config.support.smtpUser, pass: config.support.smtpPass },
  connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000, disableFileAccess: true, disableUrlAccess: true,
});
async function sendMail(t, user, shots) {
  const channels = Object.values(user.accounts || {}).map((a) => `${a.provider === 'youtube' ? 'YouTube' : 'Kick'}: ${a.channelName}`).join(', ');
  await transport().sendMail({
    from: { name: 'OmniChat Support', address: config.support.smtpUser },
    to: config.support.email,
    ...(t.email ? { replyTo: t.email } : {}),
    subject: `[OmniChat #${t.id}] ${t.category} — ${String(user.name || 'Streamer').replace(/\s+/g, ' ').slice(0, 60)}`,
    text: [
      t.message, '', '----------------------------------------',
      `Streamer: ${user.name || '-'} (${user.id})`, `Channels: ${channels || '-'}`, `Reply to: ${t.email || 'no e-mail given'}`,
      `Device: ${t.device || '-'}`, `Screenshots: ${shots.length}`, `Open in admin panel: ${config.appUrl}/#tickets/${t.id}`,
    ].join('\n'),
    attachments: shots.map((s, i) => ({ filename: `screenshot-${i + 1}.${s.type.split('/')[1].replace('jpeg', 'jpg')}`, content: s.buf, contentType: s.type })),
  });
}

// ── Tickets ──
export async function createTicket(req, user, body) {
  const message = clean(body.message, 3000);
  const email = clean(body.email, 120);
  if (message.length < 10) throw bad('Please describe the problem (at least 10 characters)');
  if (email && !EMAIL_RE.test(email)) throw bad('That e-mail address does not look right');
  const category = CATEGORIES.includes(body.category) ? body.category : CATEGORIES.at(-1);
  const recent = (await db.range('tickets', 0, 99)).filter((x) => x.uid === user.id && x.ts > Date.now() - 3_600_000);
  if (recent.length >= PER_HOUR) throw bad('You already sent several requests. Please wait an hour.', 429);

  const ids = [...new Set(Array.isArray(body.shots) ? body.shots : [])].filter((x) => typeof x === 'string' && SHOT_RE.test(x)).slice(0, MAX_SHOTS);
  const shots = [];
  for (const id of ids) {
    const s = await readShot(id);
    if (!s || s.uid !== user.id || s.ticket) throw bad('A screenshot expired. Please add it again.');
    shots.push({ ...s, id });
  }
  const t = {
    id: randomId(6), uid: user.id, ts: Date.now(), status: 'open', category, message, email: email || null, shots: ids,
    ip: clientIp(req), loc: clientLocation(req), device: clientDevice(req), mail: 'off',
  };
  const keep = async (k, v) => { await db.set(k, v); await db.expire(k, TTL); };
  // Save first: even when the e-mail fails the admin still has the request.
  await keep(`ticket/${t.id}`, t);
  await db.pushMany([['tickets', MAX_TICKETS]], { id: t.id, uid: t.uid, ts: t.ts }, { cutoff: Date.now() - TTL * 1000, ttl: TTL });
  for (const s of shots) {
    await keep(`shot/${s.id}`, { uid: s.uid, type: s.type, size: s.size, chunks: s.chunks, ticket: t.id, createdAt: s.createdAt });
    await Promise.all(shotKeys(s.id, s).slice(1).map((k) => db.expire(k, TTL)));
  }
  if (mailReady() || testTransport) {
    try { await sendMail(t, user, shots); t.mail = 'sent'; } catch (e) {
      t.mail = 'failed';
      await issue(null, { uid: user.id, kind: 'mail', message: `Support e-mail failed: ${e.code || ''} ${e.responseCode || ''} ${e.message}` });
    }
    await db.update(`ticket/${t.id}`, (x) => (x ? { ...x, mail: t.mail } : undefined), null);
    await db.expire(`ticket/${t.id}`, TTL);
  }
  return t;
}

export async function listTickets(match = () => true, limit = 200) {
  const refs = (await db.range('tickets', 0, MAX_TICKETS - 1)).filter(match).slice(0, limit);
  return (await db.mget(refs.map((r) => `ticket/${r.id}`))).filter(Boolean);
}
export const readTicket = (id) => db.get(`ticket/${id}`);
export async function setTicketStatus(id, status) {
  const t = await db.update(`ticket/${id}`, (x) => (x ? { ...x, status, closedAt: status === 'resolved' ? Date.now() : null } : undefined), null);
  if (!t) throw bad('Request not found', 404);
  await db.expire(`ticket/${id}`, TTL);
  return t;
}
/** Account deleted → tickets and screenshots go too (called before the account itself is removed). */
export async function forgetTickets(uid) {
  for (const t of await listTickets((x) => x.uid === uid, MAX_TICKETS)) {
    for (const id of t.shots || []) await Promise.all(shotKeys(id, await db.get(`shot/${id}`)).map((k) => db.del(k)));
    await db.del(`ticket/${t.id}`);
  }
  await db.dropFromList('tickets', 'uid', uid);
}

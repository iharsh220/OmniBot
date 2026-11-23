// Donations via UPI. Money goes straight from the viewer's UPI app to the streamer's UPI ID: OmniChat
// never touches it and cannot see whether a payment happened. So a viewer's "I've paid" note is only
// a *pending* entry; the streamer confirms it in Live tools → Donations, and only then an alert shows.
import * as db from './store.js';
import { randomId } from './crypto.js';
import { addEvents } from './feed.js';
import { numberAlerts } from './tools.js';

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,48}$/;
const MAX_ITEMS = 100;

export const defaultDonate = () => ({ enabled: false, upi: '', payee: '', text: 'Thank you for supporting the stream! 💜', amounts: [50, 100, 200, 500], min: 10 });
export const donateSettings = (user) => ({ ...defaultDonate(), ...(user.donate || {}) });

export function validateDonate(b, cur) {
  const next = { ...cur };
  if (b.upi !== undefined) {
    const upi = String(b.upi || '').trim();
    if (upi && !UPI_RE.test(upi)) throw Object.assign(new Error('That does not look like a UPI ID (example: name@upi, name@okaxis)'), { status: 400 });
    next.upi = upi;
  }
  if (b.payee !== undefined) next.payee = clean(b.payee, 50);
  if (b.text !== undefined) next.text = clean(b.text, 200);
  if (b.min !== undefined) next.min = Math.min(100000, Math.max(1, Math.round(Number(b.min) || 1)));
  if (b.amounts !== undefined) {
    if (!Array.isArray(b.amounts)) throw Object.assign(new Error('amounts must be a list'), { status: 400 });
    next.amounts = [...new Set(b.amounts.map((x) => Math.round(Number(x))).filter((x) => x >= 1 && x <= 100000))].slice(0, 6);
  }
  if (b.enabled !== undefined) next.enabled = !!b.enabled;
  if (next.enabled && !next.upi) throw Object.assign(new Error('Add your UPI ID first'), { status: 400 });
  return next;
}

/** upi:// link every UPI app understands (amount optional). */
export function upiLink(d, { amount, note } = {}) {
  const p = new URLSearchParams({ pa: d.upi, pn: d.payee || 'Streamer', cu: 'INR' });
  if (amount) p.set('am', Number(amount).toFixed(2));
  if (note) p.set('tn', clean(note, 60));
  return `upi://pay?${p.toString()}`;
}

/** What the public donation page / OBS widget may see (null if donations are off). */
export function publicDonate(user) {
  const d = donateSettings(user);
  if (!d.enabled || !d.upi) return null;
  return { id: user.id, name: d.payee || user.name || 'Streamer', avatar: user.avatar || null, upi: d.upi, text: d.text, amounts: d.amounts, min: d.min, link: upiLink(d) };
}

/** Viewer pressed "I've paid": store a pending note for the streamer to confirm. */
export async function submitDonation(uid, b) {
  const amount = Math.round(Number(b.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 1 || amount > 1_000_000) throw Object.assign(new Error('Enter a valid amount'), { status: 400 });
  const item = { id: randomId(10), name: clean(b.name, 40) || 'Anonymous', amount, message: clean(b.message, 200), ts: Date.now(), status: 'pending' };
  await db.update(`donations/${uid}`, (D) => {
    const pending = D.items.filter((x) => x.status === 'pending');
    if (pending.length >= 50) return undefined; // flood guard
    D.items = [item, ...D.items].slice(0, MAX_ITEMS);
    return D;
  }, { items: [] });
  return item;
}

export const readDonations = async (uid) => ((await db.get(`donations/${uid}`)) || { items: [] }).items;

/** Streamer saw the money arrive → mark received and show the Donation alert on stream. */
export async function confirmDonation(uid, user, id) {
  let hit = null;
  await db.update(`donations/${uid}`, (D) => {
    hit = null;
    const x = D.items.find((i) => i.id === id);
    if (!x || x.status !== 'pending') return undefined;
    x.status = 'received';
    x.confirmedAt = Date.now();
    hit = { ...x };
    return D;
  }, { items: [] });
  if (!hit) throw Object.assign(new Error('Donation not found or already handled'), { status: 404 });
  await showDonationAlert(uid, user, hit);
  return hit;
}

/** Put a Donation alert into the stream (Alerts widget + chat events + history). */
async function showDonationAlert(uid, user, hit) {
  const msg = {
    id: `don-${hit.id}`, platform: 'upi', ts: Date.now(), kind: 'donation', alert: 'donation', amount: `₹${hit.amount.toLocaleString('en-IN')}`,
    author: { name: hit.name, avatar: null, badges: [] }, parts: hit.message ? [{ type: 'text', text: hit.message }] : [], eventText: 'Donation',
  };
  await numberAlerts(uid, [msg]).catch(() => {});
  await addEvents(uid, { chats: [msg], historyDays: user.historyDays ?? 7 });
}

/** Streamer got a UPI payment without a note (e.g. someone scanned the raw UPI QR): add it by hand. */
export async function addManualDonation(uid, user, b) {
  const amount = Math.round(Number(b.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 1 || amount > 1_000_000) throw Object.assign(new Error('Enter a valid amount'), { status: 400 });
  const item = { id: randomId(10), name: clean(b.name, 40) || 'Anonymous', amount, message: clean(b.message, 200), ts: Date.now(), status: 'received', confirmedAt: Date.now(), manual: true };
  await db.update(`donations/${uid}`, (D) => { D.items = [item, ...D.items].slice(0, MAX_ITEMS); return D; }, { items: [] });
  await showDonationAlert(uid, user, item);
  return item;
}

export async function dismissDonation(uid, id) {
  await db.update(`donations/${uid}`, (D) => {
    const x = D.items.find((i) => i.id === id);
    if (!x) return undefined;
    x.status = x.status === 'pending' ? 'dismissed' : x.status;
    return D;
  }, { items: [] });
}


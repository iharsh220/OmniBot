import crypto from 'node:crypto';
import { config } from './config.js';

function key() {
  if (!config.appSecret || config.appSecret.length < 32) {
    throw Object.assign(new Error('Server misconfigured: APP_SECRET must be set (64 random hex chars).'), { status: 500 });
  }
  return crypto.createHash('sha256').update(config.appSecret).digest();
}

/** AES-256-GCM (authenticated) — used for OAuth tokens and the OAuth state cookie. */
export function encrypt(text) {
  if (text === null || text === undefined) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

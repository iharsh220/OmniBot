// Small Express helpers: cookies, CSRF check, rate limiting, security headers.
import { isHttps } from './config.js';

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* bad cookie */ } }
  }
  return out;
}
/**
 * Is THIS request on https? Decided from the request itself (Vercel sends x-forwarded-proto),
 * not from APP_URL, so a wrong/missing APP_URL can never make the browser drop our cookies.
 */
export function isSecureReq(req) {
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'https';
  return !!req?.socket?.encrypted || isHttps();
}
/** The request's own host (behind the Vercel proxy). */
export const reqHost = (req) => String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim().toLowerCase();

export function cookie(name, value, maxAgeSec, secure = isHttps()) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

/** CSRF: state-changing calls must come from our own pages. */
export function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try { return new URL(o).host === host; } catch { return false; }
}

// Best-effort rate limiter (in memory; on Vercel each function instance has its own).
const hits = new Map();
export function limit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now > h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n += 1;
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    if (h.n > max) return res.status(429).json({ error: 'Too many requests — slow down' });
    next();
  };
}

export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
  });
  next();
}

/** Wrap async route handlers so errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

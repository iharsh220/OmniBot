import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const useBlobs = () => process.env.OMNICHAT_STORE === 'blobs';
const useKv = () => ['kv', 'redis', 'upstash', 'vercel'].includes(process.env.OMNICHAT_STORE);

// ── local JSON file ──
let mem = null;
const file = () => path.resolve(process.env.DATA_DIR || 'data', 'store.json');
const load = () => { if (!mem) { try { mem = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { mem = {}; } } return mem; };
let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(mem), { mode: 0o600 });
  }, 50);
};
const local = {
  async get(k) { const e = load()[k]; return e ? structuredClone(e.data) : null; },
  async getWithMetadata(k) { const e = load()[k]; return e ? { data: structuredClone(e.data), etag: e.etag } : null; },
  async setJSON(k, v, o = {}) {
    const m = load();
    if (o.onlyIfMatch && m[k]?.etag !== o.onlyIfMatch) return { modified: false };
    if (o.onlyIfNew && m[k]) return { modified: false };
    m[k] = { data: structuredClone(v), etag: crypto.randomUUID() };
    save();
    return { modified: true };
  },
  async delete(k) { delete load()[k]; save(); },
};

// ── Netlify Blobs ──
// Never cache the store object: Netlify gives each invocation a short-lived Blobs token.
const netlify = {
  async get(k) { return getStore({ name: 'omnichat', consistency: 'strong' }).get(k, { type: 'json' }); },
  async getWithMetadata(k) { return getStore({ name: 'omnichat', consistency: 'strong' }).getWithMetadata(k, { type: 'json' }); },
  async setJSON(k, v, o) { return getStore({ name: 'omnichat', consistency: 'strong' }).setJSON(k, v, o); },
  async delete(k) { return getStore({ name: 'omnichat', consistency: 'strong' }).delete(k); },
};

// ── Upstash Redis / Vercel KV (REST) ──
const kvUrl = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const kvToken = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const K = (k) => `omnichat:${k}`;
const E = (k) => `omnichat:${k}:etag`;

async function kvCmd(cmd) {
  const url = kvUrl();
  const token = kvToken();
  if (!url || !token) throw new Error('KV store is not configured (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `KV HTTP ${r.status}`);
  return j.result;
}

const LUA_MATCH = `local e = redis.call('GET', KEYS[2])
if e == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('SET', KEYS[2], ARGV[3])
  return 1
end
return 0`;

const LUA_NEW = `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1`;

const redisStore = {
  async get(k) {
    const raw = await kvCmd(['GET', K(k)]);
    return raw == null ? null : JSON.parse(raw);
  },
  async getWithMetadata(k) {
    const [raw, etag] = await Promise.all([kvCmd(['GET', K(k)]), kvCmd(['GET', E(k)])]);
    if (raw == null) return null;
    return { data: JSON.parse(raw), etag: etag || null };
  },
  async setJSON(k, v, o = {}) {
    const data = JSON.stringify(v);
    const etag = crypto.randomUUID();
    if (o.onlyIfMatch) {
      const res = await kvCmd(['EVAL', LUA_MATCH, '2', K(k), E(k), o.onlyIfMatch, data, etag]);
      return { modified: Number(res) === 1 };
    }
    if (o.onlyIfNew) {
      const res = await kvCmd(['EVAL', LUA_NEW, '2', K(k), E(k), data, etag]);
      return { modified: Number(res) === 1 };
    }
    await Promise.all([kvCmd(['SET', K(k), data]), kvCmd(['SET', E(k), etag])]);
    return { modified: true };
  },
  async delete(k) {
    await kvCmd(['DEL', K(k), E(k)]);
  },
};

const backend = () => (useKv() ? redisStore : useBlobs() ? netlify : local);

export const get = (k) => backend().get(k);
export const set = (k, v) => backend().setJSON(k, v);
export const del = (k) => backend().delete(k);

/**
 * Read-modify-write with optimistic concurrency (etag): retries if another request
 * changed the value in between, so concurrent writers never overwrite each other.
 * `fn` returns the next value, or undefined to skip writing.
 */
export async function update(k, fn, fallback) {
  const s = backend();
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await s.getWithMetadata(k);
    const cur = r?.data ?? structuredClone(fallback);
    const next = await fn(cur);
    if (next === undefined) return cur;
    const res = await s.setJSON(k, next, r ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (!res || res.modified !== false) return next;
    await new Promise((x) => setTimeout(x, 40 + Math.random() * 120));
  }
  throw Object.assign(new Error('Server busy — please retry'), { status: 503 });
}

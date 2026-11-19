// Key/value storage.
//  • Netlify: Netlify Blobs (built into Netlify — no external database). Enabled by OMNICHAT_STORE=blobs
//    (set in netlify/functions/api.mjs).
//  • Local: a JSON file (data/store.json) with the same API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const useBlobs = () => process.env.OMNICHAT_STORE === 'blobs';

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
let blobs = null;
const remote = () => (blobs ||= getStore({ name: 'omnichat', consistency: 'strong' }));
const s = () => (useBlobs() ? remote() : local);

export const get = (k) => (useBlobs() ? remote().get(k, { type: 'json' }) : local.get(k));
export const set = (k, v) => s().setJSON(k, v);
export const del = (k) => s().delete(k);

/**
 * Read-modify-write with optimistic concurrency (etag): retries if another request
 * changed the value in between, so concurrent writers never overwrite each other.
 * `fn` returns the next value, or undefined to skip writing.
 */
export async function update(k, fn, fallback) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await s().getWithMetadata(k, { type: 'json' });
    const cur = r?.data ?? structuredClone(fallback);
    const next = await fn(cur);
    if (next === undefined) return cur;
    const res = await s().setJSON(k, next, r ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (!res || res.modified !== false) return next;
    await new Promise((x) => setTimeout(x, 40 + Math.random() * 120));
  }
  throw Object.assign(new Error('Server busy — please retry'), { status: 503 });
}

// Uploaded alert pictures/GIFs and sounds. Stored in the same key/value store (Upstash in production)
// as base64 chunks, so no extra storage service is needed. Served publicly at /api/media/:id
// (OBS loads them), with the type detected from the file's bytes, never trusted from the client.
import * as db from './store.js';
import { randomId } from './crypto.js';

export const MAX_BYTES = 3 * 1024 * 1024; // 3 MB per file (Vercel request limit is 4.5 MB)
const MAX_FILES = 40; // per streamer
const CHUNK = 512 * 1024; // 512 KB raw → ~683 KB base64 per key (Upstash request limit is 1 MB)

/** Detect the real type from magic bytes. Only these are accepted (no SVG/HTML → no script). */
export function sniff(buf) {
  const b = buf;
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  const str = (i, s) => b.length >= i + s.length && b.toString('latin1', i, i + s.length) === s;
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (str(0, 'GIF8')) return 'image/gif';
  if (str(0, 'RIFF') && str(8, 'WEBP')) return 'image/webp';
  if (str(0, 'RIFF') && str(8, 'WAVE')) return 'audio/wav';
  if (str(0, 'OggS')) return 'audio/ogg';
  if (str(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'audio/webm';
  if (str(4, 'ftyp')) return 'audio/mp4';
  return null;
}

export async function saveMedia(uid, buf, want) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw Object.assign(new Error('Empty file'), { status: 400 });
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('File is too big (max 3 MB)'), { status: 413 });
  const type = sniff(buf);
  if (!type) throw Object.assign(new Error('Unsupported file. Use PNG, JPG, GIF or WebP pictures, or MP3, OGG, WAV, WebM or M4A sounds.'), { status: 415 });
  if (want === 'image' && !type.startsWith('image/')) throw Object.assign(new Error('Please pick a picture or GIF'), { status: 415 });
  if (want === 'audio' && !type.startsWith('audio/')) throw Object.assign(new Error('Please pick a sound file (mp3, ogg, wav)'), { status: 415 });
  const u = await db.get(`user/${uid}`);
  if ((u?.media || []).length >= MAX_FILES) throw Object.assign(new Error(`You have ${MAX_FILES} uploads already. Remove some old ones first.`), { status: 400 });
  const id = randomId(12);
  const chunks = Math.ceil(buf.length / CHUNK);
  for (let i = 0; i < chunks; i++) await db.set(`media/${id}/${i}`, buf.subarray(i * CHUNK, (i + 1) * CHUNK).toString('base64'));
  await db.set(`media/${id}`, { uid, type, size: buf.length, chunks, createdAt: Date.now() });
  await db.update(`user/${uid}`, (x) => (x ? { ...x, media: [...(x.media || []), id].slice(-MAX_FILES) } : undefined), null);
  return { id, type, size: buf.length, url: `/api/media/${id}` };
}

export async function readMedia(id) {
  const meta = await db.get(`media/${id}`);
  if (!meta) return null;
  const parts = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => db.get(`media/${id}/${i}`)));
  if (parts.some((p) => typeof p !== 'string')) return null;
  return { type: meta.type, buf: Buffer.concat(parts.map((p) => Buffer.from(p, 'base64'))) };
}

/** Delete one upload (only its owner). */
export async function deleteMedia(uid, id) {
  const meta = await db.get(`media/${id}`);
  if (!meta || meta.uid !== uid) return false;
  await Promise.all([db.del(`media/${id}`), ...Array.from({ length: meta.chunks }, (_, i) => db.del(`media/${id}/${i}`))]);
  await db.update(`user/${uid}`, (x) => (x ? { ...x, media: (x.media || []).filter((m) => m !== id) } : undefined), null);
  return true;
}

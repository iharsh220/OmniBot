import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const e = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const dataDir = path.resolve(ROOT, e.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

// APP_SECRET encrypts OAuth tokens in the DB. Auto-generated once if not set.
let appSecret = e.APP_SECRET;
if (!appSecret) {
  const f = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  appSecret = fs.readFileSync(f, 'utf8').trim();
}

const port = num(e.PORT, 3002);

export const config = {
  root: ROOT,
  port,
  appUrl: (e.APP_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  appSecret,
  dataDir,
  // Public https base that Kick can reach for webhooks. Defaults to APP_URL.
  // Locally: run a tunnel (cloudflared/ngrok) and set PUBLIC_URL to it — login keeps using APP_URL.
  publicUrl: (e.PUBLIC_URL || e.APP_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET },
  kick: {
    clientId: e.KICK_CLIENT_ID,
    clientSecret: e.KICK_CLIENT_SECRET,
    pusherKey: e.KICK_PUSHER_KEY || '32cbd69e4b950bf97679',
    pusherCluster: e.KICK_PUSHER_CLUSTER || 'us2',
    statsPollMs: num(e.KICK_STATS_POLL_MS, 30000),
  },
  youtube: {
    minPollMs: num(e.YT_CHAT_MIN_POLL_MS, 8000),
    offlineCheckMs: num(e.YT_OFFLINE_CHECK_MS, 60000),
  },
  idleStopMs: num(e.IDLE_STOP_MS, 3 * 60_000), // stop a user's watchers this long after their last viewer leaves
  trustProxy: e.TRUST_PROXY === '1' || e.TRUST_PROXY === 'true', // set on Render/Railway/behind nginx
  maxSsePerIp: num(e.MAX_SSE_PER_IP, 30),
};

if (process.env.NODE_ENV === 'production') {
  if (!e.APP_SECRET) console.warn('⚠  APP_SECRET is not set — using data/secret.key. Set APP_SECRET in your host env so tokens survive redeploys.');
  if (!config.appUrl.startsWith('https://')) console.warn('⚠  APP_URL is not https — cookies will not be marked Secure.');
}

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

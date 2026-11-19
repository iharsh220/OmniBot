// OAuth login (Google/YouTube + Kick), sessions, account linking and token refresh.
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, encrypt, decrypt, randomId, sha256 } from './db.js';
import { log } from './logger.js';

const SESSION_COOKIE = 'oc_session';
const SESSION_TTL = 30 * 86_400_000;
const secureCookie = config.appUrl.startsWith('https://');

export const providersConfigured = () => ({
  youtube: !!(config.google.clientId && config.google.clientSecret),
  kick: !!(config.kick.clientId && config.kick.clientSecret),
});

export const redirectUri = (p) => `${config.appUrl}/auth/${p}/callback`;

// ── Cookies & sessions ─────────────────────────────────────────────────
export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`;
}

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now, now + SESSION_TTL);
  res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, token, SESSION_TTL / 1000));
}

export function destroySession(req, res) {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t));
  res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
}

export function currentUser(req) {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (!t) return null;
  const row = db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).get(sha256(t), Date.now());
  return row || null;
}

// ── OAuth state (in memory, 10 min) ────────────────────────────────────
const pending = new Map();
function newState(data) {
  const state = randomId(24);
  pending.set(state, { ...data, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  return state;
}
function takeState(state) {
  const v = pending.get(state);
  pending.delete(state);
  return v && Date.now() - v.at < 10 * 60_000 ? v : null;
}

// ── Authorize URLs ─────────────────────────────────────────────────────
export function authorizeUrl(provider, linkUserId) {
  if (provider === 'youtube') {
    const state = newState({ provider, linkUserId });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri('youtube'),
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state,
    });
    return u.toString();
  }
  if (provider === 'kick') {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = newState({ provider, linkUserId, verifier });
    const u = new URL('https://id.kick.com/oauth/authorize');
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.kick.clientId,
      redirect_uri: redirectUri('kick'),
      scope: 'user:read channel:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return u.toString();
  }
  throw new Error('Unknown provider');
}

async function postForm(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || j.message || `HTTP ${r.status}`);
  return j;
}

async function getJson(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.message || `HTTP ${r.status}`);
  return j;
}

// ── Callback: exchange code → profile ──────────────────────────────────
async function exchangeYouTube(code) {
  const t = await postForm('https://oauth2.googleapis.com/token', {
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri('youtube'),
    grant_type: 'authorization_code',
  });
  const j = await getJson('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', t.access_token);
  const ch = j.items?.[0];
  if (!ch) throw new Error('This Google account has no YouTube channel. Pick the account/brand account that owns your channel.');
  return {
    provider_user_id: ch.id,
    channel_id: ch.id,
    channel_name: ch.snippet.title,
    channel_slug: ch.snippet.customUrl || null,
    avatar: ch.snippet.thumbnails?.default?.url || null,
    tokens: t,
  };
}

async function exchangeKick(code, verifier) {
  const t = await postForm('https://id.kick.com/oauth/token', {
    grant_type: 'authorization_code',
    client_id: config.kick.clientId,
    client_secret: config.kick.clientSecret,
    redirect_uri: redirectUri('kick'),
    code_verifier: verifier,
    code,
  });
  const users = await getJson('https://api.kick.com/public/v1/users', t.access_token);
  const user = users.data?.[0];
  if (!user) throw new Error('Could not read your Kick profile');
  let channel = null;
  try {
    const ch = await getJson('https://api.kick.com/public/v1/channels', t.access_token);
    channel = ch.data?.[0] || null;
  } catch { /* scope may be missing; slug falls back to name */ }
  return {
    provider_user_id: String(user.user_id),
    channel_id: channel?.broadcaster_user_id ? String(channel.broadcaster_user_id) : String(user.user_id),
    channel_name: user.name,
    channel_slug: (channel?.slug || user.name || '').toLowerCase(),
    avatar: user.profile_picture || null,
    tokens: t,
  };
}

function saveAccount(provider, profile, linkUserId) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM accounts WHERE provider = ? AND provider_user_id = ?').get(provider, profile.provider_user_id);
  let userId;
  if (linkUserId) {
    if (existing && existing.user_id !== linkUserId) {
      throw new Error(`This ${provider === 'youtube' ? 'YouTube channel' : 'Kick account'} is already linked to another OmniChat login. Log in with it instead, or disconnect it there first.`);
    }
    userId = linkUserId;
  } else if (existing) {
    userId = existing.user_id;
  } else {
    const r = db.prepare('INSERT INTO users (name, avatar, created_at) VALUES (?, ?, ?)').run(profile.channel_name, profile.avatar, now);
    userId = Number(r.lastInsertRowid);
  }

  // One account per provider per user — replace a previously linked one.
  db.prepare('DELETE FROM accounts WHERE user_id = ? AND provider = ? AND provider_user_id <> ?').run(userId, provider, profile.provider_user_id);

  const t = profile.tokens;
  const prevRefresh = existing ? existing.refresh_token : null;
  db.prepare(`
    INSERT INTO accounts (user_id, provider, provider_user_id, channel_id, channel_name, channel_slug, avatar, access_token, refresh_token, expires_at, scope, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, provider_user_id) DO UPDATE SET
      user_id = excluded.user_id, channel_id = excluded.channel_id, channel_name = excluded.channel_name,
      channel_slug = excluded.channel_slug, avatar = excluded.avatar, access_token = excluded.access_token,
      refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope, updated_at = excluded.updated_at
  `).run(
    userId, provider, profile.provider_user_id, profile.channel_id, profile.channel_name, profile.channel_slug, profile.avatar,
    encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : prevRefresh,
    Date.now() + (t.expires_in || 3600) * 1000, t.scope || null, now, now,
  );

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u.avatar && profile.avatar) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(profile.avatar, userId);
  return userId;
}

export function ensureDefaultWidgets(userId) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM widgets WHERE user_id = ?').get(userId).n;
  if (count) return;
  const now = Date.now();
  const ins = db.prepare('INSERT INTO widgets (id, user_id, type, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run(randomId(), userId, 'chat', 'My chat', '{}', now, now);
  ins.run(randomId(), userId, 'stats', 'My stats', '{}', now, now);
}

export async function handleCallback(provider, query) {
  const st = takeState(query.get('state'));
  if (!st || st.provider !== provider) throw new Error('Login expired or invalid — please try again.');
  if (query.get('error')) throw new Error(query.get('error_description') || query.get('error'));
  const code = query.get('code');
  if (!code) throw new Error('No authorization code returned');
  const profile = provider === 'youtube' ? await exchangeYouTube(code) : await exchangeKick(code, st.verifier);
  const userId = saveAccount(provider, profile, st.linkUserId);
  ensureDefaultWidgets(userId);
  log(userId, 'info', 'auth', `${provider === 'youtube' ? 'YouTube' : 'Kick'} connected: ${profile.channel_name}`);
  return { userId, linked: !!st.linkUserId };
}

// ── Access tokens for watchers (auto refresh + persist) ────────────────
const refreshing = new Map();
export async function getAccessToken(accountId) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) throw new Error('Account was disconnected');
  if (acc.expires_at && Date.now() < acc.expires_at - 90_000) return decrypt(acc.access_token);
  if (refreshing.has(accountId)) return refreshing.get(accountId);

  const p = (async () => {
    const refresh = decrypt(acc.refresh_token);
    if (!refresh) throw Object.assign(new Error('Session expired — please reconnect this account'), { reconnect: true });
    let t;
    try {
      t = acc.provider === 'youtube'
        ? await postForm('https://oauth2.googleapis.com/token', { client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' })
        : await postForm('https://id.kick.com/oauth/token', { client_id: config.kick.clientId, client_secret: config.kick.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' });
    } catch (e) {
      throw Object.assign(new Error(`Token refresh failed (${e.message}) — please reconnect`), { reconnect: true });
    }
    db.prepare('UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated_at = ? WHERE id = ?').run(
      encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : null, Date.now() + (t.expires_in || 3600) * 1000, Date.now(), accountId,
    );
    return t.access_token;
  })();
  refreshing.set(accountId, p);
  try { return await p; } finally { refreshing.delete(accountId); }
}

export function publicAccount(a) {
  return { provider: a.provider, channelId: a.channel_id, channelName: a.channel_name, channelSlug: a.channel_slug, avatar: a.avatar, connectedAt: a.created_at, chatroomId: a.kick_chatroom_id ?? null, kickChannelId: a.kick_channel_id ?? null, followers: a.kick_followers ?? null };
}

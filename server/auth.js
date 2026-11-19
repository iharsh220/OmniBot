// OAuth (Google/YouTube + Kick), sessions, users/accounts, token refresh, revoke & delete.
import crypto from 'node:crypto';
import { config, isHttps, tfetch } from './config.js';
import { encrypt, decrypt, randomId, randomToken, sha256, safeEqual } from './crypto.js';
import { parseCookies, cookie } from './http.js';
import * as db from './store.js';
import { log } from './feed.js';

const SESSION_TTL = 30 * 86_400_000;
const STATE_TTL = 10 * 60_000;
// __Host- prefix (https only): cookie locked to this exact host, Secure, Path=/.
const SESSION = () => (isHttps() ? '__Host-oc_session' : 'oc_session');
const STATE = () => (isHttps() ? '__Host-oc_oauth' : 'oc_oauth');

export const redirectUri = (p) => `${config.appUrl}/auth/${p}/callback`;

// ── Users ──
const blankUser = (name, avatar) => ({ id: randomId(9), name, avatar, createdAt: Date.now(), historyDays: 7, accounts: {}, widgets: [], sessions: [] });
export const getUser = (uid) => db.get(`user/${uid}`);
export const updateUser = (uid, fn) => db.update(`user/${uid}`, fn, null);

// ── Sessions ──
export async function createSession(uid) {
  const token = randomToken();
  const hash = sha256(token);
  const expiresAt = Date.now() + SESSION_TTL;
  await db.set(`session/${hash}`, { uid, expiresAt });
  await updateUser(uid, (u) => {
    if (!u) return undefined;
    u.sessions = [...(u.sessions || []).filter((s) => s.expiresAt > Date.now()), { hash, expiresAt }].slice(-20);
    return u;
  });
  return cookie(SESSION(), token, SESSION_TTL / 1000);
}

export async function currentUser(req) {
  if (req._user !== undefined) return req._user;
  const t = parseCookies(req)[SESSION()];
  let user = null;
  if (t && t.length < 200) {
    const s = await db.get(`session/${sha256(t)}`);
    if (s && s.expiresAt > Date.now()) user = (await getUser(s.uid)) || null;
  }
  req._user = user;
  return user;
}

export async function destroySession(req) {
  const t = parseCookies(req)[SESSION()];
  if (t) {
    const hash = sha256(t);
    const s = await db.get(`session/${hash}`);
    await db.del(`session/${hash}`);
    if (s?.uid) await updateUser(s.uid, (u) => (u ? { ...u, sessions: (u.sessions || []).filter((x) => x.hash !== hash) } : undefined));
  }
  return cookie(SESSION(), '', 0);
}

export async function destroyAllSessions(uid) {
  const u = await getUser(uid);
  await Promise.all((u?.sessions || []).map((s) => db.del(`session/${s.hash}`)));
  await updateUser(uid, (x) => (x ? { ...x, sessions: [] } : undefined));
  return cookie(SESSION(), '', 0);
}
export const sessionCount = (u) => (u.sessions || []).filter((s) => s.expiresAt > Date.now()).length;

// ── OAuth: state + PKCE verifier in an encrypted short-lived cookie (blocks login CSRF) ──
export function authorize(provider, linkUid) {
  const state = randomToken();
  const payload = { state, provider, linkUid: linkUid || null, exp: Date.now() + STATE_TTL };
  let url;
  if (provider === 'youtube') {
    url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.google.clientId, redirect_uri: redirectUri('youtube'), response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.readonly', access_type: 'offline', prompt: 'consent select_account', state,
    });
  } else {
    payload.verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(payload.verifier).digest('base64url');
    url = new URL('https://id.kick.com/oauth/authorize');
    url.search = new URLSearchParams({
      response_type: 'code', client_id: config.kick.clientId, redirect_uri: redirectUri('kick'),
      scope: 'user:read channel:read', code_challenge: challenge, code_challenge_method: 'S256', state,
    });
  }
  return { url: url.toString(), cookie: cookie(STATE(), encrypt(JSON.stringify(payload)), STATE_TTL / 1000) };
}
export const clearStateCookie = () => cookie(STATE(), '', 0);

async function postForm(url, params) {
  const r = await tfetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || j.message || `HTTP ${r.status}`);
  return j;
}
async function getJson(url, token) {
  const r = await tfetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.message || `HTTP ${r.status}`);
  return j;
}

async function exchangeYouTube(code) {
  const t = await postForm('https://oauth2.googleapis.com/token', {
    code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: redirectUri('youtube'), grant_type: 'authorization_code',
  });
  const ch = (await getJson('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', t.access_token)).items?.[0];
  if (!ch) throw new Error('This Google account has no YouTube channel. Pick the account/brand account that owns your channel.');
  return { providerUserId: ch.id, channelId: ch.id, channelName: ch.snippet.title, channelSlug: ch.snippet.customUrl || null, avatar: ch.snippet.thumbnails?.default?.url || null, tokens: t };
}

async function exchangeKick(code, verifier) {
  const t = await postForm('https://id.kick.com/oauth/token', {
    grant_type: 'authorization_code', client_id: config.kick.clientId, client_secret: config.kick.clientSecret, redirect_uri: redirectUri('kick'), code_verifier: verifier, code,
  });
  const user = (await getJson('https://api.kick.com/public/v1/users', t.access_token)).data?.[0];
  if (!user) throw new Error('Could not read your Kick profile');
  let channel = null;
  try { channel = (await getJson('https://api.kick.com/public/v1/channels', t.access_token)).data?.[0] || null; } catch { /* optional */ }
  return {
    providerUserId: String(user.user_id), channelId: String(channel?.broadcaster_user_id || user.user_id),
    channelName: user.name, channelSlug: (channel?.slug || user.name || '').toLowerCase(), avatar: user.profile_picture || null, tokens: t,
  };
}

export async function handleCallback(provider, req) {
  let st = null;
  try { st = JSON.parse(decrypt(parseCookies(req)[STATE()]) || 'null'); } catch { st = null; }
  if (!st || st.provider !== provider || st.exp < Date.now() || !safeEqual(st.state, req.query.state)) {
    throw new Error('Login expired or invalid — please try again.');
  }
  if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
  const code = req.query.code;
  if (!code || typeof code !== 'string') throw new Error('No authorization code returned');
  const profile = provider === 'youtube' ? await exchangeYouTube(code) : await exchangeKick(code, st.verifier);
  const uid = await saveAccount(provider, profile, st.linkUid);
  await ensureDefaultWidgets(uid);
  await log(uid, 'info', 'auth', `${provider === 'youtube' ? 'YouTube' : 'Kick'} connected: ${profile.channelName}`);
  return { uid, linked: !!st.linkUid };
}

async function saveAccount(provider, p, linkUid) {
  const linkKey = `link/${provider}/${p.providerUserId}`;
  const existing = await db.get(linkKey);
  let uid;
  if (linkUid) {
    if (existing && existing.uid !== linkUid && (await getUser(existing.uid))) {
      throw new Error(`This ${provider === 'youtube' ? 'YouTube channel' : 'Kick account'} is already linked to another OmniChat login. Sign in with it instead, or disconnect it there first.`);
    }
    uid = linkUid;
  } else if (existing && (await getUser(existing.uid))) {
    uid = existing.uid;
  } else {
    const u = blankUser(p.channelName, p.avatar);
    await db.set(`user/${u.id}`, u);
    uid = u.id;
  }
  let oldLink = null;
  await updateUser(uid, (u) => {
    if (!u) throw new Error('User not found');
    const prev = u.accounts[provider];
    if (prev && prev.providerUserId !== p.providerUserId) oldLink = `link/${provider}/${prev.providerUserId}`;
    const same = prev && prev.providerUserId === p.providerUserId ? prev : {};
    u.accounts[provider] = {
      ...same, provider, providerUserId: p.providerUserId, channelId: p.channelId, channelName: p.channelName, channelSlug: p.channelSlug, avatar: p.avatar,
      accessToken: encrypt(p.tokens.access_token),
      refreshToken: p.tokens.refresh_token ? encrypt(p.tokens.refresh_token) : same.refreshToken || null,
      expiresAt: Date.now() + (p.tokens.expires_in || 3600) * 1000, scope: p.tokens.scope || null, createdAt: same.createdAt || Date.now(),
    };
    if (!u.avatar && p.avatar) u.avatar = p.avatar;
    return u;
  });
  if (oldLink) await db.del(oldLink);
  await db.set(linkKey, { uid });
  return uid;
}

export async function ensureDefaultWidgets(uid) {
  const u = await getUser(uid);
  if (!u || u.widgets?.length) return;
  const now = Date.now();
  const ids = [];
  for (const [type, name] of [['chat', 'My chat'], ['stats', 'My stats']]) {
    const id = randomId(9);
    await db.set(`widget/${id}`, { id, uid, type, name, settings: {}, createdAt: now, updatedAt: now });
    ids.push(id);
  }
  await updateUser(uid, (x) => (x ? { ...x, widgets: [...(x.widgets || []), ...ids] } : undefined));
}

// ── Access tokens (auto refresh + persist) ──
export async function getAccessToken(uid, provider) {
  const acc = (await getUser(uid))?.accounts?.[provider];
  if (!acc) throw new Error('Account was disconnected');
  if (acc.expiresAt && Date.now() < acc.expiresAt - 90_000) return decrypt(acc.accessToken);
  const refresh = decrypt(acc.refreshToken);
  if (!refresh) throw Object.assign(new Error('Session expired — please reconnect this account'), { reconnect: true });
  let t;
  try {
    t = provider === 'youtube'
      ? await postForm('https://oauth2.googleapis.com/token', { client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' })
      : await postForm('https://id.kick.com/oauth/token', { client_id: config.kick.clientId, client_secret: config.kick.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' });
  } catch (e) {
    throw Object.assign(new Error(`Token refresh failed (${e.message}) — please reconnect`), { reconnect: true });
  }
  await updateUser(uid, (x) => {
    const a = x?.accounts?.[provider];
    if (!a) return undefined;
    a.accessToken = encrypt(t.access_token);
    if (t.refresh_token) a.refreshToken = encrypt(t.refresh_token);
    a.expiresAt = Date.now() + (t.expires_in || 3600) * 1000;
    return x;
  });
  return t.access_token;
}

export function publicAccount(a) {
  return {
    provider: a.provider, channelId: a.channelId, channelName: a.channelName, channelSlug: a.channelSlug, avatar: a.avatar, connectedAt: a.createdAt,
    chatroomId: a.kickChatroomId ?? null, kickChannelId: a.kickChannelId ?? null, followers: a.kickFollowers ?? null,
  };
}

// ── Revoke + delete (privacy) ──
export async function revokeAccount(acc) {
  const token = decrypt(acc.refreshToken) || decrypt(acc.accessToken);
  if (!token) return;
  try {
    if (acc.provider === 'youtube') {
      await tfetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
    } else {
      const u = new URL('https://id.kick.com/oauth/revoke');
      u.search = new URLSearchParams({ token, token_hint_type: acc.refreshToken ? 'refresh_token' : 'access_token' });
      await tfetch(u, { method: 'POST' });
    }
  } catch { /* best effort */ }
}

export async function disconnectAccount(uid, provider) {
  const acc = (await getUser(uid))?.accounts?.[provider];
  if (!acc) return;
  await revokeAccount(acc);
  await updateUser(uid, (x) => { if (!x) return undefined; delete x.accounts[provider]; return x; });
  await db.del(`link/${provider}/${acc.providerUserId}`);
  await db.del(`live/${uid}`);
}

/** Permanently delete a user and everything stored about them. */
export async function deleteUser(uid) {
  const u = await getUser(uid);
  if (!u) return;
  await Promise.all(Object.values(u.accounts || {}).map(revokeAccount));
  const keys = [
    ...Object.values(u.accounts || {}).map((a) => `link/${a.provider}/${a.providerUserId}`),
    ...(u.sessions || []).map((s) => `session/${s.hash}`),
    ...(u.widgets || []).map((id) => `widget/${id}`),
    `live/${uid}`, `events/${uid}`, `logs/${uid}`, `history/${uid}`, `user/${uid}`,
  ];
  await Promise.all(keys.map((k) => db.del(k)));
}

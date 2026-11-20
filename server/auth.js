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
  req._authReason = 'no session cookie';
  if (t && t.length < 200) {
    const hash = sha256(t);
    let s = await db.get(`session/${hash}`);
    if (!s) { await new Promise((r) => setTimeout(r, 300)); s = await db.get(`session/${hash}`); } // tolerate a read right after login
    if (!s) req._authReason = 'session not found';
    else if (s.expiresAt <= Date.now()) req._authReason = 'session expired';
    else {
      user = (await getUser(s.uid)) || null;
      if (!user) { await new Promise((r) => setTimeout(r, 300)); user = (await getUser(s.uid)) || null; }
      if (user) { req._session = { token: t, hash, expiresAt: s.expiresAt }; req._authReason = null; }
      else req._authReason = `user ${s.uid} not found`;
    }
  }
  req._user = user;
  return user;
}

/**
 * Sliding sessions: an active user is never signed out. Once a day the session is pushed
 * 30 days ahead and the cookie re-issued. Returns a Set-Cookie value or null.
 */
export async function renewSession(req) {
  const s = req._session;
  if (!s || s.expiresAt - Date.now() > SESSION_TTL - 86_400_000) return null;
  const expiresAt = Date.now() + SESSION_TTL;
  await db.set(`session/${s.hash}`, { uid: req._user.id, expiresAt });
  await updateUser(req._user.id, (u) => {
    if (!u) return undefined;
    u.sessions = (u.sessions || []).map((x) => (x.hash === s.hash ? { ...x, expiresAt } : x));
    return u;
  });
  return cookie(SESSION(), s.token, SESSION_TTL / 1000);
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
/**
 * chatWrite: YouTube → youtube.force-ssl (post in chat); Kick → chat:write.
 * botAccount: connect a separate YouTube account that posts the Egg Bot messages (not a login).
 */
export function authorize(provider, linkUid, { chatWrite = false, botAccount = false, sharedBot = false } = {}) {
  const state = randomToken();
  const payload = { state, provider, linkUid: linkUid || null, botAccount: !!botAccount || !!sharedBot, sharedBot: !!sharedBot, exp: Date.now() + STATE_TTL };
  let url;
  if (provider === 'youtube') {
    url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.google.clientId, redirect_uri: redirectUri('youtube'), response_type: 'code',
      // youtube.force-ssl only when the streamer turns on the chat bot (it can post messages).
      scope: chatWrite || botAccount ? 'https://www.googleapis.com/auth/youtube.force-ssl' : 'https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline', prompt: 'consent select_account', state,
    });
  } else {
    payload.verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(payload.verifier).digest('base64url');
    url = new URL('https://id.kick.com/oauth/authorize');
    url.search = new URLSearchParams({
      response_type: 'code', client_id: config.kick.clientId, redirect_uri: redirectUri('kick'),
      scope: chatWrite ? 'user:read channel:read chat:write' : 'user:read channel:read', code_challenge: challenge, code_challenge_method: 'S256', state,
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
  if (st.sharedBot) {
    const admin = await getUser(st.linkUid);
    if (!admin || !isAdmin(admin) || provider !== 'youtube') throw new Error('Only an OmniChat admin can set the shared bot.');
    if (await db.get(`link/youtube/${profile.channelId}`)) {
      throw new Error(`"${profile.channelName}" is a streamer's main channel. Pick the OmniChat bot Google account instead.`);
    }
    await saveSystemBot(botRecord(profile));
    await log(st.linkUid, 'info', 'eggs', `Shared OmniChat Bot set to: ${profile.channelName}`);
    return { uid: st.linkUid, linked: true, bot: true };
  }
  if (st.botAccount) {
    if (!st.linkUid || provider !== 'youtube') throw new Error('Sign in first, then connect the bot account.');
    await saveYouTubeBot(st.linkUid, profile);
    await log(st.linkUid, 'info', 'eggs', `YouTube bot account connected: ${profile.channelName}`);
    return { uid: st.linkUid, linked: true, bot: true };
  }
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

// ── Shared OmniChat Bot (one YouTube bot account used for every streamer, set by an admin) ──
export const isAdmin = (user) => !!user?.accounts?.youtube && config.adminYouTubeChannelIds.includes(user.accounts.youtube.channelId);
const botRecord = (p) => ({
  provider: 'youtube', channelId: p.channelId, channelName: p.channelName, avatar: p.avatar,
  accessToken: encrypt(p.tokens.access_token), refreshToken: p.tokens.refresh_token ? encrypt(p.tokens.refresh_token) : null,
  expiresAt: Date.now() + (p.tokens.expires_in || 3600) * 1000, scope: p.tokens.scope || null, createdAt: Date.now(),
});
export const getSystemBot = () => db.get('system/ytbot');
export const saveSystemBot = (rec) => db.set('system/ytbot', rec);
export async function disconnectSystemBot() {
  const bot = await getSystemBot();
  // Never revoke a streamer's main channel (Google revokes the whole grant, which would log them out of YouTube).
  if (bot && !(await db.get(`link/youtube/${bot.channelId}`))) await revokeAccount(bot);
  await db.del('system/ytbot');
}
export async function getSystemBotToken() {
  const bot = await getSystemBot();
  if (!bot) throw new Error('The shared OmniChat Bot is not set up');
  if (bot.expiresAt && Date.now() < bot.expiresAt - 90_000) return decrypt(bot.accessToken);
  const refresh = decrypt(bot.refreshToken);
  if (!refresh) throw new Error('Shared OmniChat Bot needs to be reconnected by the admin');
  let t;
  try {
    t = await postForm('https://oauth2.googleapis.com/token', { client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' });
  } catch (e) {
    throw new Error(`Shared OmniChat Bot token refresh failed (${e.message}) — admin must reconnect it`);
  }
  await db.update('system/ytbot', (b) => {
    if (!b) return undefined;
    b.accessToken = encrypt(t.access_token);
    if (t.refresh_token) b.refreshToken = encrypt(t.refresh_token);
    b.expiresAt = Date.now() + (t.expires_in || 3600) * 1000;
    return b;
  }, null);
  return t.access_token;
}

/** The separate YouTube account that posts Egg Bot messages (stored on the user, never used to log in). */
async function saveYouTubeBot(uid, p) {
  await updateUser(uid, (u) => {
    if (!u) throw new Error('User not found');
    const prev = u.ytBot?.channelId === p.channelId ? u.ytBot : {};
    u.ytBot = {
      provider: 'youtube', channelId: p.channelId, channelName: p.channelName, avatar: p.avatar,
      accessToken: encrypt(p.tokens.access_token),
      refreshToken: p.tokens.refresh_token ? encrypt(p.tokens.refresh_token) : prev.refreshToken || null,
      expiresAt: Date.now() + (p.tokens.expires_in || 3600) * 1000, scope: p.tokens.scope || null, createdAt: prev.createdAt || Date.now(),
    };
    return u;
  });
}

export async function disconnectYouTubeBot(uid) {
  const bot = (await getUser(uid))?.ytBot;
  if (!bot) return;
  await revokeAccount(bot);
  await updateUser(uid, (u) => { if (!u) return undefined; delete u.ytBot; return u; });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROVIDER_NAME = { youtube: 'YouTube', kick: 'Kick' };

/**
 * Valid access token for a connected account (or the streamer's own YouTube bot with bot=true).
 *
 * Refreshing is "single-flight" across serverless instances: one request claims a short lock on the
 * account (etag write), refreshes and saves; the others wait and reuse the new token. This matters
 * for Kick, which ROTATES refresh tokens — two parallel refreshes would otherwise burn the token
 * ("The provided authorization grant … is invalid") and force a reconnect.
 */
export async function getAccessToken(uid, provider, { bot = false } = {}) {
  const pick = (u) => (bot ? u?.ytBot : u?.accounts?.[provider]);
  const label = bot ? 'YouTube bot' : PROVIDER_NAME[provider] || provider;
  const reconnectError = (why) => Object.assign(new Error(`${label} login expired${why ? ` (${why})` : ''} — please reconnect ${label}`), { reconnect: true });

  for (let attempt = 0; attempt < 8; attempt++) {
    const acc = pick(await getUser(uid));
    if (!acc) throw new Error(`${label} was disconnected`);
    const now = Date.now();
    // Refresh 5 min early; until then the current token is fine.
    if (acc.expiresAt && now < acc.expiresAt - 5 * 60_000) return decrypt(acc.accessToken);

    // Someone else is refreshing → use the current token if it still works, otherwise wait.
    if (acc.refreshingUntil > now) {
      if (acc.expiresAt && now < acc.expiresAt - 30_000) return decrypt(acc.accessToken);
      await sleep(700);
      continue;
    }

    // Claim the refresh.
    let claimed = null;
    await updateUser(uid, (x) => {
      claimed = null; // update() may re-run this on an etag conflict — only the winning write counts
      const a = pick(x);
      if (!a || a.refreshingUntil > Date.now()) return undefined;
      a.refreshingUntil = Date.now() + 20_000;
      claimed = { refreshToken: a.refreshToken, accessToken: a.accessToken };
      return x;
    });
    if (!claimed) { await sleep(500); continue; }

    const release = (patch = {}) => updateUser(uid, (x) => { const a = pick(x); if (!a) return undefined; Object.assign(a, patch); delete a.refreshingUntil; return x; });
    const refresh = decrypt(claimed.refreshToken);
    if (!refresh) { await release(); throw reconnectError('no refresh token'); }

    let t;
    try {
      t = provider === 'youtube'
        ? await postForm('https://oauth2.googleapis.com/token', { client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' })
        : await postForm('https://id.kick.com/oauth/token', { client_id: config.kick.clientId, client_secret: config.kick.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' });
    } catch (e) {
      // Maybe another instance already rotated it before our claim — use its fresh token if so.
      const fresh = pick(await getUser(uid));
      await release();
      if (fresh && fresh.accessToken !== claimed.accessToken && fresh.expiresAt > Date.now() + 60_000) return decrypt(fresh.accessToken);
      if (/network|timeout|fetch failed|aborted|5\d\d/i.test(e.message)) throw new Error(`${label} token refresh failed temporarily: ${e.message}`);
      throw reconnectError(e.message.slice(0, 80));
    }

    // Save the new tokens (retried by update()); Kick's new refresh token must never be lost.
    await release({
      accessToken: encrypt(t.access_token),
      ...(t.refresh_token ? { refreshToken: encrypt(t.refresh_token) } : {}),
      expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
    });
    return t.access_token;
  }
  // Still waiting on another refresh: hand back whatever we have (it may still be valid).
  const acc = pick(await getUser(uid));
  if (acc?.accessToken) return decrypt(acc.accessToken);
  throw reconnectError();
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
  await Promise.all([...Object.values(u.accounts || {}), ...(u.ytBot ? [u.ytBot] : [])].map(revokeAccount));
  const keys = [
    ...Object.values(u.accounts || {}).map((a) => `link/${a.provider}/${a.providerUserId}`),
    ...(u.sessions || []).map((s) => `session/${s.hash}`),
    ...(u.widgets || []).map((id) => `widget/${id}`),
    `live/${uid}`, `events/${uid}`, `logs/${uid}`, `history/${uid}`, `eggs/${uid}`, `user/${uid}`,
  ];
  await Promise.all(keys.map((k) => db.del(k)));
}

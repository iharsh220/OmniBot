// YouTube work for one user. Runs on demand (when a widget/dashboard polls) and only calls
// the API when its timers are due, to protect the shared daily quota.
import { config, BROWSER_UA, tfetch } from './config.js';
import { getAccessToken, getSystemBotToken } from './auth.js'; // getAccessToken: streamer's own YouTube (reading)

const API = 'https://www.googleapis.com/youtube/v3';
const KNOWN_TYPES = new Set([
  'textMessageEvent', 'superChatEvent', 'superStickerEvent', 'newSponsorEvent', 'memberMilestoneChatEvent',
  'membershipGiftingEvent', 'giftMembershipReceivedEvent', 'messageDeletedEvent',
  'userBannedEvent', 'chatEndedEvent', 'sponsorOnlyModeStartedEvent', 'sponsorOnlyModeEndedEvent',
]);

function badgesFor(a) {
  const b = [];
  if (a.isChatOwner) b.push({ type: 'broadcaster', label: 'Owner' });
  if (a.isChatModerator) b.push({ type: 'moderator', label: 'Moderator' });
  if (a.isChatSponsor) b.push({ type: 'member', label: 'Member' });
  if (a.isVerified) b.push({ type: 'verified', label: 'Verified' });
  return b;
}

// Vertical (Shorts) live on mobile: viewers tap 'Say "hi"' and YouTube posts "said hi" for them.
// It arrives as a plain textMessageEvent (or, if YouTube adds a new type, as its displayMessage).
const SAID_HI = /^\s*(?:\S+\s+)?said hi\s*[!.👋]*\s*$/iu;
const isSaidHi = (t) => typeof t === 'string' && t.length <= 60 && SAID_HI.test(t);

function normalise(item) {
  const s = item.snippet;
  const a = item.authorDetails || {};
  const text = (t) => (t ? [{ type: 'text', text: t }] : []);
  const base = {
    id: `yt-${item.id}`, platform: 'youtube', ts: Date.parse(s.publishedAt) || Date.now(), kind: 'chat',
    author: { name: a.displayName || 'Unknown', avatar: a.profileImageUrl || null, color: null, badges: badgesFor(a) }, parts: [],
  };
  switch (s.type) {
    case 'textMessageEvent': {
      const t = s.textMessageDetails?.messageText ?? s.displayMessage;
      if (isSaidHi(t)) return { ...base, kind: 'greeting', alert: 'greeting', eventText: '👋 said hi', greeting: true };
      return { ...base, parts: text(t) };
    }
    case 'superChatEvent': return { ...base, kind: 'superchat', alert: 'superchat', amount: s.superChatDetails?.amountDisplayString, eventText: 'Super Chat', parts: text(s.superChatDetails?.userComment) };
    case 'superStickerEvent': return { ...base, kind: 'superchat', alert: 'sticker', amount: s.superStickerDetails?.amountDisplayString, eventText: 'Super Sticker' };
    case 'newSponsorEvent': return { ...base, kind: 'member', alert: 'member', eventText: s.newSponsorDetails?.isUpgrade ? 'Upgraded membership!' : 'New member!' };
    case 'memberMilestoneChatEvent': return { ...base, kind: 'member', alert: 'milestone', eventText: `Member for ${s.memberMilestoneChatDetails?.memberMonth ?? '?'} months`, parts: text(s.memberMilestoneChatDetails?.userComment) };
    case 'membershipGiftingEvent': return { ...base, kind: 'member', alert: 'gift', eventText: `Gifted ${s.membershipGiftingDetails?.giftMembershipsCount ?? ''} memberships` };
    case 'giftMembershipReceivedEvent': return null;
    default:
      if (isSaidHi(s.displayMessage) || /said hi/i.test(String(s.type || ''))) return { ...base, kind: 'greeting', alert: 'greeting', eventText: '👋 said hi', greeting: true };
      return s.displayMessage ? { ...base, parts: text(s.displayMessage) } : null;
  }
}

async function yt(ctx, path, params) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const token = await getAccessToken(ctx.uid, 'youtube');
  const r = await tfetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `HTTP ${r.status}`), { status: r.status, reason: j.error?.errors?.[0]?.reason });
  return j;
}

const bestThumb = (s) => { const t = s?.thumbnails || {}; return (t.maxres || t.standard || t.high || t.medium || t.default)?.url || null; };

async function videoInfo(ctx, id) {
  const v = (await yt(ctx, '/videos', { part: 'snippet,liveStreamingDetails,status', id })).items?.[0];
  const d = v?.liveStreamingDetails;
  if (!d || d.actualEndTime || !d.activeLiveChatId) return null;
  return { chatId: d.activeLiveChatId, viewers: d.concurrentViewers !== undefined ? Number(d.concurrentViewers) : 0, title: v.snippet.title,
    privacy: v.status?.privacyStatus || null, startedAt: Date.parse(d.actualStartTime) || null, image: bestThumb(v.snippet) };
}

async function findLiveVideoId(ctx, channelId) {
  try {
    const j = await yt(ctx, '/liveBroadcasts', { part: 'id', broadcastStatus: 'active', broadcastType: 'all', maxResults: 5 });
    if (j.items?.length) return { id: j.items[0].id, official: true };
  } catch (e) { if (e.reconnect) throw e; }
  try { // 0-quota fallback: the public /live page
    const r = await tfetch(`https://www.youtube.com/channel/${channelId}/live`, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await r.text();
    const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
    if (m && html.includes('"isLive":true')) return { id: m[1], official: false };
  } catch { /* ignore */ }
  return null;
}

function endStream(st, L) {
  L('info', 'Stream ended');
  Object.assign(st, { live: false, viewers: null, title: null, chatConnected: false, _chatId: null, _videoId: null, _pageToken: null, _nextLiveCheckAt: Date.now() + 60_000 });
}

const hasAnalytics = (acc) => String(acc.scope || '').includes('yt-analytics.readonly');

/** Exact subscriber count from YouTube Analytics: lifetime subscribersGained − subscribersLost (every 30 min). */
async function exactSubscribers(ctx, acc, now) {
  const st = ctx.st;
  if (!hasAnalytics(acc) || now < (st._nextExactAt || 0)) return;
  st._nextExactAt = now + 30 * 60_000;
  try {
    const url = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    url.search = new URLSearchParams({
      ids: 'channel==MINE',
      startDate: String(st._publishedAt || '2005-04-23').slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
      metrics: 'subscribersGained,subscribersLost',
    });
    const token = await getAccessToken(ctx.uid, 'youtube');
    const r = await tfetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    const [gained, lost] = j.rows?.[0] || [];
    if (Number.isFinite(gained) && Number.isFinite(lost)) st._exactSubs = gained - lost;
    st._exactError = null;
  } catch (e) {
    if (st._exactError !== e.message) ctx.logs.push({ level: 'warn', source: 'youtube', message: `Exact subscriber count unavailable: ${e.message}` });
    st._exactError = e.message;
    st._nextExactAt = now + 6 * 3600_000; // don't hammer when the API/scope isn't available
  }
}

/**
 * Subscriber count WITHOUT any estimate (owner's rule: never show a guessed number).
 * - Analytics' lifetime total is exact. It is used when it is not behind YouTube's own count.
 * - The Data API's count is rounded DOWN to 3 significant digits (27,867 → 27,800). If Analytics is
 *   older than that (it lags 2–3 days), the official rounded number is shown instead.
 */
function subscriberCount(st) {
  const rounded = st._roundedSubs;
  const exact = st._exactSubs;
  st.subscribersConfirmed = exact ?? null;
  delete st._avgDaily; delete st._dataUntil; // left over from the old estimate
  if (exact != null && (rounded == null || exact >= rounded)) {
    st.subscribers = exact;
    st.subscribersMode = 'exact';
    st.subscribersExact = true;
  } else {
    st.subscribers = rounded ?? null;
    st.subscribersMode = 'rounded';
    st.subscribersExact = false;
  }
}

export const youtubeDue = (st, now) => now >= (st._nextSubsAt || 0)
  || (st.live ? now >= (st._nextChatAt || 0) || now >= (st._nextStatsAt || 0) : now >= (st._nextLiveCheckAt || 0));

/** Mutates ctx.st (state.youtube, incl. private _timers); pushes to ctx.chats / ctx.deletes / ctx.logs. */
export async function youtubeStep(ctx, acc) {
  const st = ctx.st;
  const now = Date.now();
  Object.assign(st, { connected: true, channelName: st.channelName || acc.channelName, avatar: st.avatar || acc.avatar });
  st.url ||= `https://www.youtube.com/channel/${acc.channelId}`;
  const L = (level, message) => ctx.logs.push({ level, source: 'youtube', message });
  try {
    if (now >= (st._nextSubsAt || 0)) {
      st._nextSubsAt = now + 5 * 60_000;
      const ch = (await yt(ctx, '/channels', { part: 'statistics,snippet', id: acc.channelId })).items?.[0];
      if (ch) {
        st._roundedSubs = ch.statistics.hiddenSubscriberCount ? null : Number(ch.statistics.subscriberCount);
        st._publishedAt = ch.snippet.publishedAt;
        Object.assign(st, { channelName: ch.snippet.title, avatar: ch.snippet.thumbnails?.default?.url || st.avatar });
      }
      await exactSubscribers(ctx, acc, now);
      subscriberCount(st);
    }
    if (!st.live) {
      if (now < (st._nextLiveCheckAt || 0)) return;
      st._nextLiveCheckAt = now + config.youtube.offlineCheckMs;
      const found = await findLiveVideoId(ctx, acc.channelId);
      const videoId = found?.id;
      const info = videoId ? await videoInfo(ctx, videoId) : null;
      if (!info) return;
      Object.assign(st, {
        live: true, viewers: info.viewers, title: info.title, url: `https://youtu.be/${videoId}`, chatConnected: true, error: null,
        // for the Discord announcement (official API results only)
        _official: found.official, _privacy: info.privacy, _startedAt: info.startedAt || now, _image: info.image,
        _videoId: videoId, _chatId: info.chatId, _pageToken: null, _since: now - 2 * 60_000, _nextChatAt: 0, _nextStatsAt: now + 30_000,
      });
      L('info', `LIVE: "${info.title}" (${videoId}) — chat connected`);
    }
    if (now >= (st._nextStatsAt || 0)) {
      st._nextStatsAt = now + 30_000;
      const info = await videoInfo(ctx, st._videoId);
      if (!info) return endStream(st, L);
      Object.assign(st, { viewers: info.viewers, title: info.title });
    }
    if (now >= (st._nextChatAt || 0)) {
      let j;
      try {
        j = await yt(ctx, '/liveChat/messages', { liveChatId: st._chatId, part: 'snippet,authorDetails', maxResults: 200, pageToken: st._pageToken || undefined });
      } catch (e) {
        if (['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled', 'forbidden'].includes(e.reason)) return endStream(st, L);
        if (e.reason === 'quotaExceeded' || e.reason === 'rateLimitExceeded') {
          st._nextChatAt = now + 10 * 60_000;
          st.error = 'YouTube API quota exceeded';
          L('error', 'YouTube API quota exceeded — chat paused 10 min (quota resets at midnight Pacific)');
          return;
        }
        throw e;
      }
      st._pageToken = j.nextPageToken || st._pageToken;
      st._nextChatAt = now + Math.max(j.pollingIntervalMillis || 0, config.youtube.minPollMs);
      st.error = null;
      const seen = new Set(st._seenTypes || []);
      for (const item of j.items || []) {
        const type = item.snippet?.type;
        if (type && !KNOWN_TYPES.has(type) && !seen.has(type)) {
          seen.add(type);
          L('info', `New YouTube chat event type: ${type}${item.snippet?.displayMessage ? ` — "${String(item.snippet.displayMessage).slice(0, 80)}"` : ''}`);
        }
        if (type === 'messageDeletedEvent') { ctx.deletes.push(`yt-${item.snippet.messageDeletedDetails?.deletedMessageId}`); continue; }
        const msg = normalise(item);
        if (msg && msg.ts >= (st._since || 0)) {
          ctx.chats.push(msg);
          const text = (msg.parts || []).map((p) => p.text || '').join('').trim();
          if (/^!egghistory\b/i.test(text)) ctx.commands?.push(msg.author.name);
        }
      }
      st._seenTypes = [...seen].slice(-50);
      if (j.offlineAt) endStream(st, L);
    }
  } catch (e) {
    st.error = e.reconnect ? e.message : `YouTube: ${e.message}`;
    L(e.reconnect ? 'error' : 'warn', st.error);
    if (e.reconnect) st._nextLiveCheckAt = now + 10 * 60_000;
  }
}

// ── Discord announcements: one-off calls with a ready access token ──
async function ytGet(token, path, params) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const r = await tfetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `HTTP ${r.status}`), { status: r.status, reason: j.error?.errors?.[0]?.reason });
  return j;
}
/** The streamer's own broadcasts that are live right now (1 quota unit). */
export async function activeBroadcasts(token) {
  const j = await ytGet(token, '/liveBroadcasts', { part: 'snippet,status', broadcastStatus: 'active', broadcastType: 'all', maxResults: 10 });
  return (j.items || []).filter((b) => b.status?.lifeCycleStatus === 'live').map((b) => ({
    id: b.id, title: b.snippet.title, privacy: b.status.privacyStatus, start: Date.parse(b.snippet.actualStartTime) || Date.now(), image: bestThumb(b.snippet),
  }));
}
/** Details of some videos (1 unit). width/height come from the player and tell upright videos (Shorts) apart. */
export async function videosByIds(token, ids) {
  if (!ids.length) return [];
  const j = await ytGet(token, '/videos', { part: 'snippet,status,contentDetails,liveStreamingDetails,player', id: ids.join(','), maxHeight: 720, maxWidth: 1280 });
  return (j.items || []).map((v) => ({
    id: v.id, channelId: v.snippet.channelId, title: v.snippet.title, published: Date.parse(v.snippet.publishedAt) || 0, broadcast: v.snippet.liveBroadcastContent, image: bestThumb(v.snippet),
    privacy: v.status?.privacyStatus, durationIso: v.contentDetails?.duration, wasLive: !!v.liveStreamingDetails, start: Date.parse(v.liveStreamingDetails?.actualStartTime) || Date.now(),
    width: Number(v.player?.embedWidth) || 0, height: Number(v.player?.embedHeight) || 0,
  }));
}
/** Newest uploads (1 unit; +1 the first time to look up the uploads playlist). */
export async function uploadIds(token, channelId, playlist) {
  const list = playlist || (await ytGet(token, '/channels', { part: 'contentDetails', id: channelId })).items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!list) return { playlist: null, items: [] };
  const j = await ytGet(token, '/playlistItems', { part: 'contentDetails', playlistId: list, maxResults: 5 });
  return { playlist: list, items: (j.items || []).map((x) => ({ id: x.contentDetails.videoId, published: Date.parse(x.contentDetails.videoPublishedAt) || 0 })) };
}

/** Send a message to a live chat as the shared OmniChat Bot (youtube.force-ssl). ~50 quota units. */
export async function postChat(uid, liveChatId, text) {
  const token = await getSystemBotToken();
  const r = await tfetch(`${API}/liveChat/messages?part=snippet`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: String(text).slice(0, 200) } } }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error?.message || `HTTP ${r.status}`);
  }
}

export const canWriteChat = (acc) => !!acc?.scope && acc.scope.includes('youtube.force-ssl');
/** The Egg Bot posts on YouTube only as the shared OmniChat Bot (one bot for every streamer). */
export const youtubeBotReady = (_user, sharedBot) => canWriteChat(sharedBot);

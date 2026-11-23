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
      if (isSaidHi(t)) return { ...base, kind: 'greeting', eventText: '👋 said hi', greeting: true };
      return { ...base, parts: text(t) };
    }
    case 'superChatEvent': return { ...base, kind: 'superchat', amount: s.superChatDetails?.amountDisplayString, eventText: 'Super Chat', parts: text(s.superChatDetails?.userComment) };
    case 'superStickerEvent': return { ...base, kind: 'superchat', amount: s.superStickerDetails?.amountDisplayString, eventText: 'Super Sticker' };
    case 'newSponsorEvent': return { ...base, kind: 'member', eventText: s.newSponsorDetails?.isUpgrade ? 'Upgraded membership!' : 'New member!' };
    case 'memberMilestoneChatEvent': return { ...base, kind: 'member', eventText: `Member for ${s.memberMilestoneChatDetails?.memberMonth ?? '?'} months`, parts: text(s.memberMilestoneChatDetails?.userComment) };
    case 'membershipGiftingEvent': return { ...base, kind: 'member', eventText: `Gifted ${s.membershipGiftingDetails?.giftMembershipsCount ?? ''} memberships` };
    case 'giftMembershipReceivedEvent': return null;
    default:
      if (isSaidHi(s.displayMessage) || /said hi/i.test(String(s.type || ''))) return { ...base, kind: 'greeting', eventText: '👋 said hi', greeting: true };
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

async function videoInfo(ctx, id) {
  const v = (await yt(ctx, '/videos', { part: 'snippet,liveStreamingDetails', id })).items?.[0];
  const d = v?.liveStreamingDetails;
  if (!d || d.actualEndTime || !d.activeLiveChatId) return null;
  return { chatId: d.activeLiveChatId, viewers: d.concurrentViewers !== undefined ? Number(d.concurrentViewers) : 0, title: v.snippet.title };
}

async function findLiveVideoId(ctx, channelId) {
  try {
    const j = await yt(ctx, '/liveBroadcasts', { part: 'id', broadcastStatus: 'active', broadcastType: 'all', maxResults: 5 });
    if (j.items?.length) return j.items[0].id;
  } catch (e) { if (e.reconnect) throw e; }
  try { // 0-quota fallback: the public /live page
    const r = await tfetch(`https://www.youtube.com/channel/${channelId}/live`, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await r.text();
    const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
    if (m && html.includes('"isLive":true')) return m[1];
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

    // Daily breakdown (last ~5 weeks): how far behind Analytics is + average daily growth.
    const day = (d) => d.toISOString().slice(0, 10);
    const dUrl = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    dUrl.search = new URLSearchParams({
      ids: 'channel==MINE', startDate: day(new Date(now - 35 * 86_400_000)), endDate: day(new Date(now)),
      metrics: 'subscribersGained,subscribersLost', dimensions: 'day', sort: 'day',
    });
    const dr = await tfetch(dUrl, { headers: { Authorization: `Bearer ${token}` } });
    const dj = await dr.json().catch(() => ({}));
    const rows = (dr.ok && dj.rows) || [];
    if (rows.length) {
      const recent = rows.slice(-28);
      st._avgDaily = recent.reduce((sum, r) => sum + (r[1] - r[2]), 0) / recent.length;
      st._dataUntil = Date.parse(`${rows[rows.length - 1][0]}T23:59:59Z`); // last day Analytics has
    }
  } catch (e) {
    if (st._exactError !== e.message) ctx.logs.push({ level: 'warn', source: 'youtube', message: `Exact subscriber count unavailable: ${e.message}` });
    st._exactError = e.message;
    st._nextExactAt = now + 6 * 3600_000; // don't hammer when the API/scope isn't available
  }
}

/**
 * Studio-like live count. Analytics' lifetime total is exact but 2–3 days old, so add the average
 * daily growth for the missing days. The Data API's rounded value (rounded DOWN to 3 significant
 * digits) bounds the truth: 27,800 means 27,800 … 27,899 — the estimate is clamped into that range.
 */
function liveSubscriberEstimate(st, now) {
  const floor = st._roundedSubs;
  const confirmed = st._exactSubs;
  st.subscribersConfirmed = confirmed ?? null; // exact, as of the last Analytics day
  if (confirmed == null) {
    st.subscribers = floor ?? null;
    st.subscribersMode = 'rounded';
    st.subscribersExact = false;
    return;
  }
  let est = confirmed;
  if (Number.isFinite(st._avgDaily) && st._dataUntil) est += st._avgDaily * Math.max(0, (now - st._dataUntil) / 86_400_000);
  if (floor != null && floor > 0) {
    const step = 10 ** Math.max(0, String(Math.floor(floor)).length - 3); // 27,800 → 100
    est = Math.min(Math.max(est, floor), floor + step - 1);
  }
  st.subscribers = Math.round(est);
  st.subscribersMode = 'live';
  st.subscribersExact = true;
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
      liveSubscriberEstimate(st, now);
    }
    if (!st.live) {
      if (now < (st._nextLiveCheckAt || 0)) return;
      st._nextLiveCheckAt = now + config.youtube.offlineCheckMs;
      const videoId = await findLiveVideoId(ctx, acc.channelId);
      const info = videoId ? await videoInfo(ctx, videoId) : null;
      if (!info) return;
      Object.assign(st, {
        live: true, viewers: info.viewers, title: info.title, url: `https://youtu.be/${videoId}`, chatConnected: true, error: null,
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

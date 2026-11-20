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

function normalise(item) {
  const s = item.snippet;
  const a = item.authorDetails || {};
  const text = (t) => (t ? [{ type: 'text', text: t }] : []);
  const base = {
    id: `yt-${item.id}`, platform: 'youtube', ts: Date.parse(s.publishedAt) || Date.now(), kind: 'chat',
    author: { name: a.displayName || 'Unknown', avatar: a.profileImageUrl || null, color: null, badges: badgesFor(a) }, parts: [],
  };
  switch (s.type) {
    case 'textMessageEvent': return { ...base, parts: text(s.textMessageDetails?.messageText ?? s.displayMessage) };
    case 'superChatEvent': return { ...base, kind: 'superchat', amount: s.superChatDetails?.amountDisplayString, eventText: 'Super Chat', parts: text(s.superChatDetails?.userComment) };
    case 'superStickerEvent': return { ...base, kind: 'superchat', amount: s.superStickerDetails?.amountDisplayString, eventText: 'Super Sticker' };
    case 'newSponsorEvent': return { ...base, kind: 'member', eventText: s.newSponsorDetails?.isUpgrade ? 'Upgraded membership!' : 'New member!' };
    case 'memberMilestoneChatEvent': return { ...base, kind: 'member', eventText: `Member for ${s.memberMilestoneChatDetails?.memberMonth ?? '?'} months`, parts: text(s.memberMilestoneChatDetails?.userComment) };
    case 'membershipGiftingEvent': return { ...base, kind: 'member', eventText: `Gifted ${s.membershipGiftingDetails?.giftMembershipsCount ?? ''} memberships` };
    case 'giftMembershipReceivedEvent': return null;
    default: return s.displayMessage ? { ...base, parts: text(s.displayMessage) } : null;
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
      if (ch) Object.assign(st, { subscribers: ch.statistics.hiddenSubscriberCount ? null : Number(ch.statistics.subscriberCount), channelName: ch.snippet.title, avatar: ch.snippet.thumbnails?.default?.url || st.avatar });
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

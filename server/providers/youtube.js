import { config, BROWSER_UA } from '../config.js';
import { getAccessToken } from '../auth.js';
import { Watcher } from './base.js';

const API = 'https://www.googleapis.com/youtube/v3';
const c = config.youtube;

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
    author: { name: a.displayName || 'Unknown', avatar: a.profileImageUrl || null, color: null, badges: badgesFor(a) },
    parts: [],
  };
  switch (s.type) {
    case 'textMessageEvent':
      return { ...base, parts: text(s.textMessageDetails?.messageText ?? s.displayMessage) };
    case 'superChatEvent':
      return { ...base, kind: 'superchat', amount: s.superChatDetails?.amountDisplayString, eventText: 'Super Chat', parts: text(s.superChatDetails?.userComment) };
    case 'superStickerEvent':
      return { ...base, kind: 'superchat', amount: s.superStickerDetails?.amountDisplayString, eventText: 'Super Sticker' };
    case 'newSponsorEvent':
      return { ...base, kind: 'member', eventText: s.newSponsorDetails?.isUpgrade ? 'Upgraded membership!' : 'New member!' };
    case 'memberMilestoneChatEvent':
      return { ...base, kind: 'member', eventText: `Member for ${s.memberMilestoneChatDetails?.memberMonth ?? '?'} months`, parts: text(s.memberMilestoneChatDetails?.userComment) };
    case 'membershipGiftingEvent':
      return { ...base, kind: 'member', eventText: `Gifted ${s.membershipGiftingDetails?.giftMembershipsCount ?? ''} memberships` };
    case 'giftMembershipReceivedEvent':
      return null;
    default:
      return s.displayMessage ? { ...base, parts: text(s.displayMessage) } : null;
  }
}

export class YouTubeWatcher extends Watcher {
  platform = 'youtube';

  async yt(path, params) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const token = await getAccessToken(this.account.id);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(j.error?.message || `HTTP ${r.status}`);
      err.status = r.status;
      err.reason = j.error?.errors?.[0]?.reason;
      throw err;
    }
    return j;
  }

  start() {
    this.log('info', `Watching YouTube channel "${this.account.channel_name}"`);
    this.update({ url: `https://www.youtube.com/channel/${this.account.channel_id}`, error: null });
    this.refreshChannel();
    this.every(5 * 60_000, () => this.refreshChannel());
    this.liveLoop();
  }

  async refreshChannel() {
    try {
      const j = await this.yt('/channels', { part: 'statistics,snippet', id: this.account.channel_id });
      const ch = j.items?.[0];
      if (!ch) return;
      this.update({
        subscribers: ch.statistics.hiddenSubscriberCount ? null : Number(ch.statistics.subscriberCount),
        channelName: ch.snippet.title,
        avatar: ch.snippet.thumbnails?.default?.url || null,
      });
    } catch (e) {
      this.fail('Could not load subscriber count', e);
    }
  }

  fail(what, e) {
    const msg = `${what}: ${e.message}`;
    this.log(e.reconnect ? 'error' : 'warn', msg);
    this.update({ error: e.reconnect ? e.message : msg });
    if (e.reconnect) this.stop();
  }

  async findLiveVideoId() {
    try {
      const j = await this.yt('/liveBroadcasts', { part: 'id', broadcastStatus: 'active', broadcastType: 'all', maxResults: 5 });
      if (j.items?.length) return j.items[0].id;
    } catch (e) {
      if (e.reconnect) throw e;
      this.log('warn', `liveBroadcasts lookup failed: ${e.message}`);
    }
    // Fallback: public /live page (0 quota) — handles brand-account edge cases.
    try {
      const r = await fetch(`https://www.youtube.com/channel/${this.account.channel_id}/live`, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' } });
      const html = await r.text();
      const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
      if (m && html.includes('"isLive":true')) return m[1];
    } catch { /* ignore */ }
    return null;
  }

  async videoInfo(id) {
    const j = await this.yt('/videos', { part: 'snippet,liveStreamingDetails', id });
    const v = j.items?.[0];
    const d = v?.liveStreamingDetails;
    if (!d || d.actualEndTime || !d.activeLiveChatId) return null;
    return { chatId: d.activeLiveChatId, viewers: d.concurrentViewers !== undefined ? Number(d.concurrentViewers) : 0, title: v.snippet.title };
  }

  async liveLoop() {
    let wasLive = false;
    while (!this.stopped) {
      try {
        const videoId = await this.findLiveVideoId();
        const info = videoId && !this.stopped ? await this.videoInfo(videoId) : null;
        if (info) {
          wasLive = true;
          await this.runChat(videoId, info);
        }
        if (!this.stopped) {
          if (wasLive) this.log('info', 'Stream ended');
          wasLive = false;
          this.update({ live: false, viewers: null, title: null, chatConnected: false, url: `https://www.youtube.com/channel/${this.account.channel_id}` });
        }
      } catch (e) {
        this.fail('Live check failed', e);
      }
      await this.wait(c.offlineCheckMs);
    }
  }

  async runChat(videoId, info) {
    this.log('info', `LIVE: "${info.title}" (${videoId}) — chat connected`);
    this.update({ live: true, viewers: info.viewers, title: info.title, url: `https://youtu.be/${videoId}`, chatConnected: true, error: null });
    const since = Date.now() - 2 * 60_000;
    let pageToken;
    let lastStats = Date.now();

    while (!this.stopped) {
      let j;
      try {
        j = await this.yt('/liveChat/messages', { liveChatId: info.chatId, part: 'snippet,authorDetails', maxResults: 200, pageToken });
      } catch (e) {
        if (e.reconnect) throw e;
        if (['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled', 'forbidden'].includes(e.reason)) return;
        if (e.reason === 'quotaExceeded' || e.reason === 'rateLimitExceeded') {
          this.log('error', 'YouTube API quota exceeded — chat paused 10 min (quota resets at midnight Pacific)');
          this.update({ error: 'YouTube API quota exceeded' });
          await this.wait(10 * 60_000);
          continue;
        }
        this.log('warn', `Chat poll error: ${e.message}`);
        await this.wait(15_000);
        continue;
      }
      if (this.hub.state.youtube.error) this.update({ error: null });
      pageToken = j.nextPageToken;
      for (const item of j.items || []) {
        if (item.snippet?.type === 'messageDeletedEvent') {
          this.hub.remove(`yt-${item.snippet.messageDeletedDetails?.deletedMessageId}`);
          continue;
        }
        const msg = normalise(item);
        if (msg && msg.ts >= since) this.hub.chat(msg);
      }
      if (j.offlineAt) return;
      if (Date.now() - lastStats > 30_000) {
        lastStats = Date.now();
        try {
          const i = await this.videoInfo(videoId);
          if (!i) return;
          this.update({ viewers: i.viewers, title: i.title, error: null });
        } catch (e) {
          this.log('warn', `Viewer refresh failed: ${e.message}`);
        }
      }
      await this.wait(Math.max(j.pollingIntervalMillis || 0, c.minPollMs));
    }
  }
}

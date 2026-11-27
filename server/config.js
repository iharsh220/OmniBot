// App configuration from environment variables.
// Vercel: Settings → Environment Variables. Local: .env (loaded by server/local.js).
const e = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  // APP_URL = the public site URL (custom domain). Local dev forces localhost (server/local.js).
  // Vercel: falls back to the production domain (VERCEL_PROJECT_PRODUCTION_URL) when APP_URL is not set.
  get appUrl() {
    const vercel = e.VERCEL_PROJECT_PRODUCTION_URL || e.VERCEL_URL;
    return (e.APP_URL || e.URL || (vercel ? `https://${vercel}` : '') || `http://localhost:${e.PORT || 3002}`).trim().replace(/\/+$/, '');
  },
  get appSecret() { return e.APP_SECRET || ''; },
  google: { get clientId() { return e.GOOGLE_CLIENT_ID; }, get clientSecret() { return e.GOOGLE_CLIENT_SECRET; } },
  kick: { get clientId() { return e.KICK_CLIENT_ID; }, get clientSecret() { return e.KICK_CLIENT_SECRET; } },
  youtube: {
    get minPollMs() { return num(e.YT_CHAT_MIN_POLL_MS, 3000); },
    get offlineCheckMs() { return num(e.YT_OFFLINE_CHECK_MS, 60000); },
  },
  get kickStatsMs() { return num(e.KICK_STATS_POLL_MS, 30000); },
  // Help & support mailbox (the OmniChat Bot's e-mail). Gmail: SMTP_PASS = an App Password, never the normal password.
  support: {
    get email() { return String(e.SUPPORT_EMAIL || '').trim(); },
    get smtpUser() { return String(e.SMTP_USER || e.SUPPORT_EMAIL || '').trim(); },
    get smtpPass() { return String(e.SMTP_PASS || '').replace(/\s+/g, ''); },
    get smtpHost() { return String(e.SMTP_HOST || 'smtp.gmail.com').trim(); },
    get smtpPort() { return num(e.SMTP_PORT, 465); },
  },
  discord: {
    get botToken() { return e.DISCORD_BOT_TOKEN || ''; },
    // "Add to Discord" for every streamer (Discord Developer Portal → OAuth2 → Client Secret). Not needed for the owner's own server.
    get clientSecret() { return String(e.DISCORD_CLIENT_SECRET || '').trim(); },
    // YouTube channel(s) of the owner: their server is found automatically.
    get streamers() { return String(e.DISCORD_OWNER_CHANNELS || 'UCDWjmqpDTta7B1TcYDnDgZQ').split(',').map((x) => x.trim()).filter(Boolean); },
  },
  // Secret of the 1-minute scheduler (Authorization: Bearer <CRON_SECRET>).
  get cronSecret() { return String(e.CRON_SECRET || '').trim(); },
  // YouTube channel ID of the OmniChat Bot account. When that account signs in to OmniChat it becomes
  // the bot automatically, and only it can see/reconnect the bot settings.
  get botYouTubeChannelId() { return String(e.BOT_YOUTUBE_CHANNEL_ID || '').trim(); },
  // Kick channel (broadcaster user) ID of the OmniChat Bot account. When that account connects to Kick
  // with chat:write, it becomes the shared bot that posts in every streamer's Kick chat.
  get botKickChannelId() { return String(e.BOT_KICK_CHANNEL_ID || '').trim(); },
  eggs: {
    get pollMs() { return num(e.EGG_POLL_MS, 5000); },        // how often to read the Discord channel
    get dailyPostLimit() { return num(e.EGG_DAILY_POST_LIMIT, 120); }, // YouTube quota guard (~50 units / message)
  },
};

export const isHttps = () => config.appUrl.startsWith('https://');
export const providersConfigured = () => ({
  youtube: !!(config.google.clientId && config.google.clientSecret),
  kick: !!(config.kick.clientId && config.kick.clientSecret),
});

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** fetch with a hard timeout so a slow provider can never hang a request. */
export function tfetch(url, opts = {}, ms = 6000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

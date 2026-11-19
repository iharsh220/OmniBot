// App configuration from environment variables.
// Netlify: Site configuration → Environment variables. Local: .env (loaded by server/local.js).
const e = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  // Netlify sets URL to the site's primary URL. APP_URL overrides it (custom domain / local dev).
  get appUrl() { return (e.APP_URL || e.URL || `http://localhost:${e.PORT || 3002}`).replace(/\/+$/, ''); },
  get appSecret() { return e.APP_SECRET || ''; },
  google: { get clientId() { return e.GOOGLE_CLIENT_ID; }, get clientSecret() { return e.GOOGLE_CLIENT_SECRET; } },
  kick: { get clientId() { return e.KICK_CLIENT_ID; }, get clientSecret() { return e.KICK_CLIENT_SECRET; } },
  youtube: {
    get minPollMs() { return num(e.YT_CHAT_MIN_POLL_MS, 8000); },
    get offlineCheckMs() { return num(e.YT_OFFLINE_CHECK_MS, 60000); },
  },
  get kickStatsMs() { return num(e.KICK_STATS_POLL_MS, 30000); },
  discord: { get botToken() { return e.DISCORD_BOT_TOKEN || ''; } },
  eggs: {
    get pollMs() { return num(e.EGG_POLL_MS, 10000); },        // how often to read the Discord channel
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

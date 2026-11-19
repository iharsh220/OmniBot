# OmniChat

Your **YouTube and Kick live chat in one overlay**, plus a live **viewers and subscribers/followers** widget. Streamers log in with YouTube or Kick, design their overlay (10 themes or a custom design), and paste one URL into OBS, Streamlabs, or a transparent desktop overlay app.

- 💬 **Combined live chat** from YouTube and Kick: badges, emotes, Super Chats, memberships and subs
- 📊 **Stats widget**: live viewers, YouTube subscribers, Kick followers/subscribers, total viewers
- 🎨 **10 themes + custom designer**: colors, opacity, fully transparent background, fonts, size, radius, animations, auto-hide, filters
- 🔗 **Saved widget URLs** (`/w/<id>`): edits you make in the dashboard show up live in OBS, so you never re-copy the URL
- 👥 **Multi-user**: every streamer connects their own channels with OAuth
- 📜 **Logs and chat history** in the dashboard
- 🗄️ **No external database**: embedded SQLite, built into Node.js
- 📦 **Zero frameworks**: Node.js plus plain HTML, CSS and JavaScript

---

## Requirements

- **Node.js 22.13 or newer** (uses the built-in `node:sqlite`)
- A **Google Cloud** OAuth client, for YouTube login
- A **Kick developer app**, for Kick login

## Quick start

```bash
git clone https://github.com/iharsh220/OmniBot.git
cd OmniBot
npm install
# create .env (see "Configuration" below)
npm start            # or: npm run dev  (auto-restart on changes)
```

Open `http://localhost:3002`, or whatever port is in your `APP_URL`, and sign in.

## Configuration

Create a `.env` file in the project root. **Never commit it.**

```ini
# ── Server ──
PORT=3002
APP_URL=http://localhost:3002          # public URL of the app (used for OAuth redirects)
APP_SECRET=                            # 64 random hex chars; encrypts tokens. Auto-generated locally if empty.
# PUBLIC_URL=https://xxxx.trycloudflare.com   # optional: public https URL for Kick webhooks (local testing)

# ── YouTube login ──
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# ── Kick login ──
KICK_CLIENT_ID=
KICK_CLIENT_SECRET=

# ── Optional ──
# YT_CHAT_MIN_POLL_MS=8000     # min delay between YouTube chat polls (saves quota)
# YT_OFFLINE_CHECK_MS=60000    # how often to check if a channel went live
# KICK_STATS_POLL_MS=30000
# IDLE_STOP_MS=180000          # pause a user's watchers after their last widget/dashboard closes
# DATA_DIR=data                # where the SQLite database lives
# TRUST_PROXY=1                # set when running behind a reverse proxy / PaaS
# MAX_SSE_PER_IP=30
# KICK_PUSHER_KEY=34bf7a0ff419a2a775b9   # Kick live socket (follower updates); change if Kick rotates it
# KICK_PUSHER_CLUSTER=us2
```

### 1. YouTube (Google Cloud)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. **APIs & Services → Library**: enable **YouTube Data API v3**.
3. **OAuth consent screen**: add the scope `.../auth/youtube.readonly`. While the app is in *Testing*, add every streamer's Google account under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized redirect URI: `{APP_URL}/auth/youtube/callback`, for example `http://localhost:3002/auth/youtube/callback`
5. Copy the Client ID and Secret into `.env`.

### 2. Kick

1. Go to [kick.com/settings/developer](https://kick.com/settings/developer). Two-factor authentication is required.
2. **Create App**:
   - **Redirect URL:** `{APP_URL}/auth/kick/callback`
   - **Scopes:** ✅ *Read user information* · ✅ *Read channel information* (nothing else is needed)
   - **Webhooks** (for automatic chat): enable, with URL `{PUBLIC_URL or APP_URL}/webhooks/kick`
3. Copy the Client ID and Secret into `.env`.

> ⚠️ The redirect URLs must match **exactly** (scheme, host, port, path). A mismatch gives `redirect_uri_mismatch` (Google) or `invalid authorization request` (Kick).

## Using the widgets

1. Sign in, then open **Studio**.
2. Pick a widget (**Chat** or **Stats**), choose a theme, and tweak colors, opacity and fonts. Changes save automatically.
3. Click **Copy** to get the widget URL.
4. Add it to your streaming software:
   - **OBS / Streamlabs:** Sources → **+** → **Browser** → paste the URL. Use 400 × 700 for chat, about 800 × 140 for stats.
   - **Desktop overlay apps** (for example [Transparent-Twitch-Chat-Overlay](https://github.com/baffler/Transparent-Twitch-Chat-Overlay)): paste the URL in its custom URL option.
5. Go live. Chat and stats appear within a few seconds.

You can create as many widgets as you want, each with its own URL and look.

## How the platforms are read

| | YouTube | Kick |
|---|---|---|
| Live detection | `liveBroadcasts` (owner OAuth) | Official API `channels` |
| Viewers | `videos.liveStreamingDetails` | Official API `stream.viewer_count` |
| Subs/followers | `channels.statistics.subscriberCount` | Subscribers from the official API. Followers come from a one-time sync, then live updates |
| Chat | `liveChat/messages` polling | **Official webhooks** (automatic), or the public chat socket |

### Kick notes
- **Chat is automatic** when OmniChat runs on a **public https URL** with webhooks enabled in your Kick app. To test locally, run a tunnel and set `PUBLIC_URL`:
  ```bash
  cloudflared tunnel --url http://localhost:3002     # or: npx localtunnel --port 3002
  ```
- **Followers:** Kick's official API does not expose the follower total. In **Connections → Kick → One-time sync**, open the linked channel page, copy everything and paste it. OmniChat saves the total and then keeps it updated live.

### YouTube quota
The YouTube Data API allows about **10,000 units per day per Google project**, shared by all users. Chat polling costs about 5 units per request, so with the default 8 s interval one live stream uses roughly 2,250 units per hour. For many streamers, [request a quota increase](https://support.google.com/youtube/contact/yt_api_form) or raise `YT_CHAT_MIN_POLL_MS`. Watchers only run while a widget or the dashboard is open.

## Deployment

OmniChat needs a **long-running Node.js process** (chat polling, sockets, live updates) and a **persistent disk** for SQLite. That means **static or serverless hosts such as Netlify or Vercel will not work**.

Good options: **Railway** (with a volume), **Render** (paid plan + disk), **Fly.io** (volume), or any **VPS**.

Set these environment variables on the host:

```ini
NODE_ENV=production
APP_URL=https://your-domain.com
APP_SECRET=<64 random hex chars — never change it after users sign in>
TRUST_PROXY=1
DATA_DIR=/path/to/persistent/volume
GOOGLE_CLIENT_ID=...    GOOGLE_CLIENT_SECRET=...
KICK_CLIENT_ID=...      KICK_CLIENT_SECRET=...
```

Start command: `npm start`. Then add the production redirect URLs (`https://your-domain.com/auth/youtube/callback`, `https://your-domain.com/auth/kick/callback`) and the Kick webhook URL (`https://your-domain.com/webhooks/kick`).

Generate a secret with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Security

- OAuth tokens are **encrypted (AES-256-GCM)** in the database. Sessions store only a hash of the cookie token.
- Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` on https.
- Strict **Content-Security-Policy**. The dashboard cannot be framed. CSRF protection uses an `Origin` check.
- Rate limiting on login, API writes and live connections.
- Kick webhooks are **signature-verified** (RSA-SHA256) with replay protection.
- All chat text is rendered safely (no HTML injection).
- Read-only platform scopes: OmniChat never posts, moderates, or reads stream keys.

## Project structure

```
server/
  index.js              HTTP server and routes (pages, OAuth, REST API, live events, webhooks)
  config.js             environment configuration
  db.js                 SQLite schema, migrations, token encryption
  auth.js               OAuth (Google, Kick), sessions, account linking, token refresh
  hub.js                per-user live state, chat buffer, connected clients
  logger.js             logs to console + database + dashboard
  providers/youtube.js  YouTube live/viewers/subscribers/chat
  providers/kick.js     Kick stats, chat (webhooks/socket), followers
public/
  login.html            sign-in page
  index.html            dashboard (Studio · Connections · Logs)
  widget.html           the overlay served at /w/<id>
  js/  css/             front-end modules and themes
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `redirect_uri_mismatch` (Google) | Add `{APP_URL}/auth/youtube/callback` exactly to the OAuth client's redirect URIs |
| `invalid authorization request` (Kick) | Redirect URL in the Kick app must equal `{APP_URL}/auth/kick/callback`; scopes must include user + channel read |
| `access_denied` (Google) | Add your Google account to the consent screen's **Test users** |
| Kick chat not showing | Enable webhooks with a public https URL, or do the one-time sync in Connections |
| Kick followers show “—” | Do the one-time sync in **Connections → Kick** |
| Stats stuck / "quota exceeded" | YouTube API daily quota used up; it resets at midnight Pacific Time |

Check the **Logs** page in the dashboard for details.

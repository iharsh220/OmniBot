# OmniChat

Your **YouTube and Kick live chat in one overlay**, plus a live **viewers and subscribers/followers** widget. Streamers sign in with YouTube or Kick, design their overlay (10 themes or a custom design), and paste one URL into OBS, Streamlabs, or a transparent desktop overlay app.

- 💬 **Combined live chat** from YouTube and Kick: badges, emotes, Super Chats, memberships, subs
- 📊 **Stats widget**: live viewers, YouTube subscribers, Kick followers/subscribers, total viewers
- 🎨 **10 themes + custom designer**: colors, opacity, transparent background, fonts, animations, filters
- 🔗 **Saved widget URLs** (`/w/<id>`): edits in the dashboard show up in OBS automatically
- 👥 **Multi-user**: every streamer connects their own channels with OAuth
- 🌓 Light / dark / system theme · 📜 logs & chat history · 🔐 encrypted tokens

**Stack:** Express API + plain HTML/CSS/JS, deployed on **Netlify** (Express runs as a Netlify Function via `serverless-http`, data in **Netlify Blobs**).

---

## Run locally

```bash
npm install
npm run dev          # → http://localhost:3002
```

Create a `.env` in the project root (it's gitignored and never deployed):

```ini
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
KICK_CLIENT_ID=
KICK_CLIENT_SECRET=
DISCORD_BOT_TOKEN=    # Egg Bot (optional)
# APP_SECRET=         # optional locally (auto-generated in data/secret.key)
# PORT=3002
```

Locally the app always uses `http://localhost:3002` as its URL, and data is kept in `data/store.json`.

## Deploy on Netlify

1. Push the repo to GitHub and import it in Netlify. **`netlify.toml` configures everything** (publish `public`, functions `netlify/functions`, redirects, security headers).
2. **Site configuration → Environment variables:**

   | Variable | Value |
   |---|---|
   | `APP_SECRET` | **Required.** 64 random hex chars, never change it later: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google Cloud |
   | `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` | from kick.com/settings/developer |
   | `DISCORD_BOT_TOKEN` | Egg Bot only — from discord.com/developers → your app → Bot |
   | `ADMIN_YOUTUBE_CHANNEL_ID` | Your YouTube channel ID (UC…): lets you set the shared OmniChat Bot |
   | `APP_URL` | optional; only for a custom domain (Netlify provides its URL automatically) |

3. **Google Cloud** → APIs & Services → enable **YouTube Data API v3**. Then Credentials → OAuth client (Web application) → Authorized redirect URI:
   `https://<your-site>.netlify.app/auth/youtube/callback`
   While the consent screen is in *Testing*, add each streamer under **Test users**.
4. **Kick** → kick.com/settings/developer → your app:
   - Redirect URL: `https://<your-site>.netlify.app/auth/kick/callback`
   - Scopes: *Read user information* + *Read channel information*
   - Webhooks: enabled, URL `https://<your-site>.netlify.app/webhooks/kick`
5. Push to git. Netlify deploys automatically.

## Using the widgets

1. Sign in → **Studio** → pick a widget → choose a theme → **Copy URL**.
2. **OBS / Streamlabs:** Sources → **+** → **Browser** → paste the URL (chat 400 × 700, stats about 800 × 140).
   **Overlay apps** (e.g. [Transparent-Twitch-Chat-Overlay](https://github.com/baffler/Transparent-Twitch-Chat-Overlay)): paste the URL as the custom URL.
3. Go live. Chat and stats appear within a few seconds.

## 🥚 Egg Bot (Steal an Egg)

Posts new egg spawns from your Discord channel (e.g. `#🥚-egg-stock`, filled by a notifier bot) into your **YouTube and Kick live chat**. You can switch it ON/OFF from the dashboard. Viewers can type **`!egghistory`** to see the last 10 eggs.

- **Discord:** create a bot at discord.com/developers. Turn on *Message Content Intent*. Invite it with *View Channel + Read Message History*. Put its token in `DISCORD_BOT_TOKEN`.
- **YouTube:** messages come from a **bot account**, never your main channel:
  - **OmniChat Bot (shared, default):** one bot for every streamer, set by the admin (`ADMIN_YOUTUBE_CHANNEL_ID` env). Streamers only switch the Egg Bot ON. They can make the bot a moderator on their channel.
  - **My own bot:** a streamer connects their own extra Google account in **Egg Bot → Connect my bot account**.
- **Kick:** messages come from your **Kick app's bot**. In your Kick app enable the scope *Write to Chat feed*, then click **Egg Bot → Give permission**.
- Each YouTube message costs about 50 API quota units, so the bot posts at most `EGG_DAILY_POST_LIMIT` (120) messages per day.

## How it works on Netlify

Netlify Functions can't run forever, keep files, or hold open connections, so:
- Widgets and the dashboard **poll** the API every few seconds.
- On each poll the server does any YouTube/Kick work that is due (live check, chat, viewers). YouTube is therefore only checked while a widget or the dashboard is open.
- **Kick chat** arrives through Kick's official signed **webhooks**.
- Data (users, widgets, logs, chat history) is stored in **Netlify Blobs**.

**Limits:**
- Chat has a ~2–5 s delay.
- Each poll is a Function call, so check your Netlify plan limits.
- The YouTube API allows about 10,000 quota units per day per Google project, shared by all users.
- YouTube's API rounds subscriber counts (e.g. 27.8K).
- Kick's official API has no follower total, so followers sync automatically from your browser when the dashboard is open.

## Security

- Read-only OAuth scopes; OAuth tokens encrypted with AES-256-GCM
- `__Host-` HttpOnly cookies; login protected against CSRF
- Strict CSP; dashboard can't be framed
- Rate limits; signed Kick webhooks with replay protection
- Users can set chat history retention, sign out everywhere, regenerate widget URLs, and delete their account (all data removed, tokens revoked)

## Troubleshooting

| Problem | Fix |
|---|---|
| Netlify "Page not found" | Make sure `netlify.toml` is in the repo root and publish dir is `public` |
| Login error 500 / "APP_SECRET must be set" | Add `APP_SECRET` in Netlify environment variables and redeploy |
| `redirect_uri_mismatch` (Google) | Add `https://<site>/auth/youtube/callback` exactly |
| `invalid authorization request` (Kick) | Redirect URL in the Kick app must be `https://<site>/auth/kick/callback` |
| `access_denied` (Google) | Add your Google account to the consent screen's Test users |
| Kick chat not showing | Enable Webhooks in the Kick app with `https://<site>/webhooks/kick` |
| "quota exceeded" | YouTube daily quota is used up; it resets at midnight Pacific |

Check **Logs** in the dashboard for details.

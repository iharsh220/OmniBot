// Small Discord REST client + "which channels was the bot put into?" (nobody ever types a channel ID).
import { config, tfetch } from './config.js';

const DISCORD = 'https://discord.com/api/v10';
const REASON = { 401: 'The Discord bot token is not valid', 403: 'The bot has no permission in this channel', 404: 'Discord channel or server not found', 429: 'Discord rate limit' };

export async function dapi(path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await tfetch(DISCORD + path, { ...opts, headers: { Authorization: `Bot ${config.discord.botToken}`, ...(opts.headers || {}) } }, 8000);
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    if (r.status === 429 && attempt === 0 && Number(j.retry_after) <= 3) { await new Promise((ok) => setTimeout(ok, Number(j.retry_after) * 1000 + 100)); continue; }
    throw Object.assign(new Error(REASON[r.status] || `Discord HTTP ${r.status}: ${String(j.message || '').slice(0, 120)}`), { discord: r.status });
  }
}

let bot = null;
/** The bot user; its id is also the application (client) id. */
export async function botId() {
  bot ||= (await dapi('/users/@me')).id;
  return bot;
}
export const botGuilds = () => dapi('/users/@me/guilds');

// What OmniChat needs to announce: view, send, embed, attach, read history, mention everyone.
export const PERMS = { 'View Channel': 10n, 'Send Messages': 11n, 'Embed Links': 14n, 'Attach Files': 15n, 'Read Message History': 16n, 'Mention @everyone': 17n };
export const INVITE_PERMISSIONS = String(Object.values(PERMS).reduce((p, bit) => p | (1n << bit), 0n));
export const has = (perms, name) => !!(perms & (1n << PERMS[name]));

/** Channel names in fancy fonts (𝗬𝗼𝘂𝗧𝘂𝗯𝗲, 🔴┃ｋｉｃｋ) → plain lower case. */
export const plain = (name) => String(name || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

const cache = new Map();
/**
 * Text + announcement channels of a server: [{ id, name, perms, explicit, missing }].
 * explicit = somebody added the bot (or its own role) to that channel's permissions, i.e. "the bot was put there".
 */
export async function guildChannels(guildId, { fresh = false } = {}) {
  const hit = cache.get(guildId);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.list;
  const me = await botId();
  const [channels, roles, member] = await Promise.all([dapi(`/guilds/${guildId}/channels`), dapi(`/guilds/${guildId}/roles`), dapi(`/guilds/${guildId}/members/${me}`)]);
  const mine = new Set([guildId, ...(member.roles || [])]);
  const own = roles.find((r) => r.tags?.bot_id === me)?.id;
  let base = 0n;
  for (const r of roles) if (mine.has(r.id)) base |= BigInt(r.permissions);
  const admin = !!(base & 8n);
  const list = channels.filter((c) => c.type === 0 || c.type === 5).sort((a, b) => a.position - b.position).map((c) => {
    const ow = c.permission_overwrites || [];
    let p = base;
    const apply = (allow, deny) => { p = (p & ~deny) | allow; };
    const everyone = ow.find((o) => o.id === guildId);
    const self = ow.find((o) => o.id === me);
    if (everyone) apply(BigInt(everyone.allow), BigInt(everyone.deny));
    let allow = 0n; let deny = 0n;
    for (const o of ow) if (o.type === 0 && o.id !== guildId && mine.has(o.id)) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
    apply(allow, deny);
    if (self) apply(BigInt(self.allow), BigInt(self.deny));
    if (admin) p = ~0n;
    const explicit = ow.some((o) => (o.id === me || o.id === own) && (BigInt(o.allow) & ((1n << 10n) | (1n << 11n))));
    return { id: c.id, name: c.name, perms: p, explicit, missing: Object.keys(PERMS).filter((k) => !has(p, k)) };
  });
  cache.set(guildId, { at: Date.now(), list });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return list;
}

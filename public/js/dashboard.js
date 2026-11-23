import { DEFAULTS, THEMES, FONTS, applyRoot, normalizeSettings, ALERT_KINDS, WIDGET_PRESETS, mediaUrl } from './settings.js';
import { ChatView, StatsView, EggsView, createMessageEl, ICONS } from './render.js';
import { connectLive, startDemo, startEggDemo } from './feed.js';
import { icon, hydrateIcons, bindThemeSwitch } from './icons.js';
import { AlertsView, GoalView, PollView, DonateView, startAlertDemo, demoPoll, demoGoalState, demoDonate, playAlertSound, synth } from './live-views.js';

// ═════════════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════════════
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny DOM builder. All text goes through textContent; `html` is only used with our own static icons. */
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
}
const ic = (name) => h('span', { html: icon(name), style: 'display:contents' });

/** Not signed in → the login page ("Continue as …" is one click). Only real problems show an error. */
function signedOutUrl(reason) {
  if (!reason || reason === 'no session cookie') return '/login';
  return '/login?error=' + encodeURIComponent(`Signed out (${reason}). Please sign in again.`);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) {
    const me = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    if (me && me.status === 401) {
      const j = await me.json().catch(() => ({}));
      location.replace(signedOutUrl(j.reason));
      throw new Error('Signed out');
    }
    throw new Error('Connection problem — please try again');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function toast(msg, type = 'ok') {
  const t = h('div', { class: `toast ${type}`, role: 'status' }, ic(type === 'err' ? 'error' : 'check'), h('span', {}, msg));
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, type === 'err' ? 5000 : 2200);
}

/** Accessible confirm dialog. Resolves to true (or content's data-value), false when cancelled. */
function dialog({ title, text, confirm = 'Confirm', danger = false, requireText = null, content = null }) {
  return new Promise((resolve) => {
    const input = requireText ? h('input', { class: 'input', placeholder: `Type ${requireText} to confirm`, 'aria-label': 'Confirmation' }) : null;
    const ok = h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'button', disabled: requireText ? true : undefined }, confirm);
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const bg = h('div', { class: 'modal-bg', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal' }, h('h3', {}, title), text ? h('p', {}, text) : null, content, input, h('div', { class: 'row' }, cancel, ok)));
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); if (e.key === 'Enter' && !ok.disabled) ok.click(); };
    input?.addEventListener('input', () => { ok.disabled = input.value.trim() !== requireText; });
    cancel.addEventListener('click', () => close(false));
    bg.addEventListener('click', (e) => { if (e.target === bg) close(false); });
    ok.addEventListener('click', () => close(content?.dataset?.value ?? true));
    document.addEventListener('keydown', onKey);
    document.body.append(bg);
    (input || ok).focus();
  });
}

const fmtN = (x) => (x === null || x === undefined ? '—' : Number(x).toLocaleString('en-US'));
const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60); if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = h('textarea', {}, text); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast('Copied to clipboard');
}
const widgetUrl = (w) => `${location.origin}/w/${w.id}`;

// ═════════════════════════════════════════════════════════════════════
//  State
// ═════════════════════════════════════════════════════════════════════
let me = null;
let widgets = [];
let current = null;
let settings = { ...DEFAULTS };
let feedMode = 'demo';
let liveState = null;
let liveHistory = [];
let demo = null;
let page = 'overview';
let studioTab = 'theme';
let serverOk = false;

const PAGES = {
  overview: ['Overview', 'Your stream at a glance'],
  studio: ['Studio', 'Design your overlays — every change is saved and goes live instantly'],
  tools: ['Live tools', 'Highlight chat on stream, run polls, bot commands & timers, stream summary'],
  donations: ['Donations', 'Your UPI donation page, QR code and donation notes'],
  connections: ['Connections', 'Link the platforms you stream on'],
  eggs: ['Egg Bot', 'Post Steal an Egg spawns from your Discord into YouTube & Kick chat'],
  logs: ['Logs', 'What OmniChat is doing, and your chat history'],
  settings: ['Settings', 'Appearance, privacy and security'],
};

// ═════════════════════════════════════════════════════════════════════
//  Studio — control schema
// ═════════════════════════════════════════════════════════════════════
const TABS = {
  chat: [['theme', 'Theme', 'sparkles'], ['style', 'Style', 'palette'], ['layout', 'Layout', 'layout'], ['content', 'Content', 'message'], ['filters', 'Filters', 'filter']],
  stats: [['theme', 'Theme', 'sparkles'], ['style', 'Style', 'palette'], ['layout', 'Layout', 'layout'], ['content', 'Content', 'chart']],
  eggs: [['theme', 'Theme', 'sparkles'], ['style', 'Style', 'palette'], ['layout', 'Layout', 'layout'], ['content', 'Content', 'egg']],
  alerts: [['theme', 'Theme', 'sparkles'], ['style', 'Style', 'palette'], ['layout', 'Look & timing', 'layout'], ['content', 'Which alerts', 'zap']],
  goal: [['theme', 'Theme', 'sparkles'], ['style', 'Style', 'palette'], ['content', 'Goal', 'chart']],
  poll: [['theme', 'Theme', 'sparkles'], ['style', 'Style', 'palette'], ['content', 'Poll', 'message']],
  donate: [['theme', 'Theme', 'sparkles'], ['style', 'Style', 'palette'], ['layout', 'Layout', 'layout'], ['content', 'Content', 'heart']],
};
// Studio type picker / lists: emoji + icon + label per widget type
const TYPE_META = {
  chat: ['', 'message', 'Chat'], stats: ['', 'chart', 'Stats'], eggs: ['', 'egg', 'Eggs'],
  alerts: ['', 'bell', 'Alerts'], goal: ['', 'target', 'Goal'], poll: ['', 'vote', 'Poll'], donate: ['', 'qr', 'Donate QR'],
};
const SECTION_INFO = {
  theme: () => ['10 ready-made looks — pick one to start'],
  style: () => ['Colors, border, background, fonts, shape & avatar'],
  layout: (type) => [{ chat: 'Alignment, width, animation & timing', eggs: 'Board, alert, events · fit to screen', alerts: 'Style, position, animation, time on screen & sound', donate: 'Card, stacked or scanner only · size & UPI placement' }[type] || 'Row, column or pill · alignment'],
  content: (type) => [{ chat: 'Avatar, badges, time, events & emotes', eggs: 'How many eggs, latest card, details & highlights', alerts: 'Super Chats, members, Kick subs & follows, highlights', goal: 'Subscribers or followers · target & title', poll: 'Hide when idle · vote hint', donate: 'Title, subtitle, UPI ID & donation link' }[type] || 'Viewers, subs, total · titles, icons & labels'],
  filters: () => ['Platforms, commands, users, links, words & length'],
};

const ANIM_OPTIONS = [
  ['slide', 'Slide in (from the side)'], ['slide-right', 'Slide in (other side)'], ['rise', 'Rise up'], ['drop', 'Drop down'],
  ['fade', 'Fade'], ['pop', 'Pop'], ['zoom', 'Zoom in'], ['bounce', 'Bounce'], ['elastic', 'Elastic'], ['flip', '3D flip'],
  ['swing', 'Swing'], ['blur', 'Blur in'], ['wipe', 'Wipe reveal'], ['glitch', 'Glitch'], ['none', 'None'],
];
const isAlert = (s) => current?.type === 'alerts' || s.eggsLayout === 'alert';
// Alerts widget: one section per alert kind (on/off, text, sound, own sound URL, own picture, test)
const KIND_INFO = {
  Superchat: ['superchat', 'Super Chats & Stickers', 'YouTube'], Member: ['member', 'New members & milestones', 'YouTube'],
  Gift: ['gift', 'Gifted memberships / subs', 'YouTube + Kick'], KickSub: ['sub', 'Subs & resubs', 'Kick'],
  Follow: ['follow', 'New followers', 'Kick (YouTube does not report new subscribers live)'], Greeting: ['greeting', '“Said hi”', 'YouTube vertical live'],
  Highlight: ['highlight', 'Highlighted messages', 'Live tools → Live chat → Show'],
  Donation: ['donation', 'Donations (UPI)', 'Shows when you press Received on the Donations page'],
};
const KIND_ICON = { Superchat: 'coin', Member: 'star', Gift: 'gift', KickSub: 'star', Follow: 'userplus', Greeting: 'hand', Highlight: 'star', Donation: 'rupee' };
const SOUND_OPTIONS = [['default', 'Default for this alert'], ['chime', 'Chime'], ['coin', 'Coin'], ['cash', 'Cash register'], ['fanfare', 'Fanfare'], ['tada', 'Ta-da'],
  ['pop', 'Pop'], ['bubble', 'Bubbles'], ['sparkle', 'Sparkle'], ['magic', 'Magic'], ['bell', 'Bell'], ['notify', 'Notify'], ['levelup', 'Level up'], ['powerup', 'Power up'],
  ['airhorn', 'Air horn'], ['drumroll', 'Drum roll'], ['laser', 'Laser'], ['heartbeat', 'Heartbeat'], ['whoosh', 'Whoosh'], ['custom', 'My own sound (upload)'], ['none', 'No sound']];
// "Which alerts": pick ONE alert type in a dropdown, its settings show below (UI state only, not saved)
let editKind = 'Superchat';
const typeOfKind = (K) => KIND_INFO[K][0];
const ALERT_EDIT_GROUP = { tab: 'content', title: 'Customize an alert', types: ['alerts'], fields: [
  { t: 'kindpick', label: 'Alert type', hint: 'Pick one, change its settings below, then test it' },
  ...ALERT_KINDS.flatMap(([K, text]) => {
    const sel = () => editKind === K;
    const on = (s) => sel() && s[`alert${K}`] !== false;
    return [
      { k: `alert${K}`, t: 'toggle', label: 'Show this alert', hint: KIND_INFO[K][2], show: sel },
      { k: `alert${K}Text`, t: 'text', label: 'Text on the alert', placeholder: text, show: on, hint: 'Variables: {name} {amount} {event} {count} {platform}' },
      { k: `alert${K}Sound`, t: 'select', label: 'Sound', show: on, options: SOUND_OPTIONS, rebuild: true },
      { k: `alert${K}SoundUrl`, t: 'upload', accept: 'audio/*', kind: 'audio', label: 'Your sound file', show: (s) => on(s) && s[`alert${K}Sound`] === 'custom', hint: 'MP3, OGG, WAV or M4A · up to 3 MB · short sounds work best' },
      { t: 'action', icon: 'volume', label: 'Play sound', show: (s) => on(s) && s[`alert${K}Sound`] !== 'none', run: () => playAlertSound({ ...settings, alertSound: true }, typeOfKind(K)) },
      { k: `alert${K}Image`, t: 'upload', accept: 'image/png,image/jpeg,image/gif,image/webp', kind: 'image', label: 'Your picture / GIF (optional)', show: on, hint: 'Shown instead of the viewer’s avatar · PNG, JPG, GIF, WebP · up to 3 MB' },
      { t: 'action', icon: 'play', label: 'Test this alert (preview + OBS)', show: on, run: () => sendTestToObs(typeOfKind(K)) },
    ];
  }),
] };
const GROUPS = [
  { tab: 'style', title: 'Colors', fields: [
    { k: 'textColor', t: 'color', label: 'Text' },
    { k: 'accent', t: 'color', label: 'Accent' },
    { k: 'msgBg', t: 'color', label: 'Card background' },
    { k: 'msgBgOpacity', t: 'range', label: 'Card opacity', min: 0, max: 100, unit: '%' },
    { k: 'nameColor', t: 'seg', label: 'Usernames', types: ['chat'], options: [['user', 'User'], ['platform', 'Platform'], ['accent', 'Accent'], ['custom', 'Custom']] },
    { k: 'nameColorCustom', t: 'color', label: 'Name color', types: ['chat'], show: (s) => s.nameColor === 'custom' },
  ] },
  { tab: 'style', title: 'Border', fields: [
    { k: 'borderWidth', t: 'range', label: 'Border width', min: 0, max: 6, fmt: (v) => (v === 0 ? 'None' : `${v}px`) },
    { k: 'borderColor', t: 'color', label: 'Border color', show: (s) => s.borderWidth > 0 },
    { k: 'borderOpacity', t: 'range', label: 'Border opacity', min: 0, max: 100, unit: '%', show: (s) => s.borderWidth > 0 },
  ] },
  { tab: 'style', title: 'Background', fields: [
    { k: 'pageBg', t: 'color', label: 'Widget background' },
    { k: 'pageBgOpacity', t: 'range', label: 'Background opacity', min: 0, max: 100, fmt: (v) => (v === 0 ? 'Transparent' : `${v}%`) },
    { t: 'quick' },
  ] },
  { tab: 'style', title: 'Typography', fields: [
    { k: 'font', t: 'select', label: 'Font', options: Object.keys(FONTS).map((f) => [f, f]) },
    { k: 'fontSize', t: 'range', label: 'Size', min: 10, max: 40, unit: 'px' },
    { k: 'fontWeight', t: 'select', label: 'Weight', num: true, options: [[400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold']] },
    { k: 'nameWeight', t: 'select', label: 'Name weight', num: true, types: ['chat'], options: [[400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']] },
    { k: 'lineHeight', t: 'range', label: 'Line spacing', min: 100, max: 200, fmt: (v) => (v / 100).toFixed(2) },
    { k: 'stroke', t: 'toggle', label: 'Text outline', hint: 'Keeps text readable on busy game backgrounds' },
  ] },
  { tab: 'style', title: 'Shape', fields: [
    { k: 'radius', t: 'range', label: 'Corner radius', min: 0, max: 30, unit: 'px' },
    { k: 'padding', t: 'range', label: 'Padding', min: 2, max: 24, unit: 'px' },
    { k: 'gap', t: 'range', label: 'Spacing', min: 0, max: 24, unit: 'px' },
    { k: 'shadow', t: 'toggle', label: 'Shadow' },
  ] },
  { tab: 'style', title: 'Avatar', types: ['chat'], fields: [
    { k: 'avatarShape', t: 'seg', label: 'Shape', options: [['circle', 'Circle'], ['rounded', 'Rounded'], ['square', 'Square']] },
    { k: 'avatarSize', t: 'range', label: 'Size', min: 60, max: 200, unit: '%' },
  ] },
  { tab: 'layout', title: 'Motion', types: ['chat'], fields: [
    { k: 'animation', t: 'select', label: 'Animation', options: ANIM_OPTIONS },
    { k: 'animSpeed', t: 'seg', label: 'Speed', options: [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']] },
    { k: 'direction', t: 'seg', label: 'New messages', options: [['bottom', 'Bottom'], ['top', 'Top']] },
  ] },
  { tab: 'layout', title: 'Arrangement', types: ['chat'], fields: [
    { k: 'align', t: 'seg', label: 'Align messages', options: [['left', 'Left'], ['right', 'Right']] },
    { k: 'maxWidth', t: 'range', label: 'Message width', min: 30, max: 100, unit: '%', hint: 'Narrower cards leave more of your game visible' },
    { k: 'compact', t: 'toggle', label: 'Compact (one line)', hint: 'Name and message on the same line' },
  ] },
  { tab: 'layout', title: 'Flow', types: ['chat'], fields: [
    { k: 'hideAfter', t: 'range', label: 'Hide after', min: 0, max: 120, fmt: (v) => (v === 0 ? 'Never' : `${v}s`), hint: 'Messages fade away after this many seconds' },
    { k: 'maxMessages', t: 'range', label: 'Max messages', min: 3, max: 100 },
  ] },
  { tab: 'content', title: 'Message parts', types: ['chat'], fields: [
    { k: 'showAvatar', t: 'toggle', label: 'Avatar' },
    { k: 'showBadges', t: 'toggle', label: 'Badges' },
    { k: 'showPlatform', t: 'toggle', label: 'Platform icon' },
    { k: 'showTime', t: 'toggle', label: 'Timestamp' },
    { k: 'timeFormat', t: 'seg', label: 'Time format', options: [['24h', '24-hour'], ['12h', '12-hour']], show: (s) => s.showTime },
  ] },
  { tab: 'content', title: 'Extras', types: ['chat'], fields: [
    { k: 'showEvents', t: 'toggle', label: 'Super Chats & subs', hint: 'Show Super Chats, memberships and Kick subs' },
    { k: 'emoteSize', t: 'range', label: 'Emote size', min: 100, max: 300, unit: '%' },
  ] },
  { tab: 'filters', title: 'Sources', types: ['chat'], fields: [
    { k: 'youtube', t: 'toggle', label: 'YouTube chat' },
    { k: 'kick', t: 'toggle', label: 'Kick chat' },
  ] },
  { tab: 'filters', title: 'Hide', types: ['chat'], fields: [
    { k: 'hideCommands', t: 'toggle', label: 'Bot commands', hint: 'Hide messages that start with !' },
    { k: 'hideBots', t: 'text', label: 'Usernames', placeholder: 'nightbot, botrix', stack: true, hint: 'Comma separated — these users never show up' },
    { k: 'hideLinks', t: 'toggle', label: 'Links', hint: 'Hide messages that contain a link' },
    { k: 'blockedWords', t: 'text', label: 'Blocked words', placeholder: 'spoiler, scam', stack: true, hint: 'Comma separated — messages with these words are hidden' },
  ] },
  { tab: 'filters', title: 'Length', types: ['chat'], fields: [
    { k: 'minLength', t: 'range', label: 'Hide shorter than', min: 0, max: 30, fmt: (v) => (v === 0 ? 'Off' : `${v} chars`) },
    { k: 'maxLength', t: 'range', label: 'Shorten after', min: 0, max: 300, step: 10, fmt: (v) => (v === 0 ? 'Never' : `${v} chars`) },
  ] },
  { tab: 'content', title: 'What to show', types: ['stats'], fields: [
    { k: 'statsViewers', t: 'toggle', label: 'Live viewers', hint: 'Turn off to show only subscribers / followers' },
    { k: 'statsSubs', t: 'toggle', label: 'Subscribers / followers', hint: 'Turn off to show only live viewers' },
    { k: 'statsTotal', t: 'toggle', label: 'Total watching card', hint: 'YouTube + Kick viewers added together', show: (s) => s.statsViewers },
    { k: 'statsYoutube', t: 'toggle', label: 'YouTube card' },
    { k: 'statsKick', t: 'toggle', label: 'Kick card' },
    { k: 'statsHideOffline', t: 'toggle', label: 'Hide when offline' },
  ] },
  { tab: 'content', title: 'Card title', types: ['stats'], fields: [
    { k: 'statsHeader', t: 'seg', label: 'Title shows', options: [['both', 'Icon + name'], ['icon', 'Icon'], ['name', 'Name'], ['none', 'Nothing']] },
    { k: 'statsLiveBadge', t: 'toggle', label: 'LIVE badge' },
  ] },
  { tab: 'content', title: 'Numbers', types: ['stats'], fields: [
    { k: 'statsIcons', t: 'toggle', label: 'Icons (eye / people)' },
    { k: 'statsLabels', t: 'toggle', label: 'Labels' },
    { k: 'statsViewersText', t: 'text', label: 'Viewers label', placeholder: 'watching', show: (s) => s.statsLabels && s.statsViewers },
    { k: 'statsSubsText', t: 'text', label: 'Subs label', placeholder: 'auto: subscribers / followers', show: (s) => s.statsLabels && s.statsSubs },
    { k: 'statsTotalText', t: 'text', label: 'Total card title', placeholder: 'Total watching', show: (s) => s.statsTotal && s.statsViewers },
    { k: 'statsCompact', t: 'toggle', label: 'Compact numbers', hint: '15,320 → 15.3K' },
    { k: 'statsNumSize', t: 'range', label: 'Number size', min: 60, max: 200, unit: '%' },
  ] },
  { tab: 'layout', title: 'Eggs layout', types: ['eggs'], fields: [
    { k: 'eggsLayout', t: 'select', label: 'Layout', options: [['alert', 'Alert — new egg / event pops up'], ['board', 'Stock board (by rarity)'], ['spotlight', 'Last spawn + events (alert card)'], ['events', 'Events only'], ['list', 'One list'], ['grouped', 'By location']] },
    { k: 'eggsOrient', t: 'seg', label: 'Stream', options: [['horizontal', 'Horizontal 16:9'], ['vertical', 'Vertical 9:16']], show: (s) => ['alert', 'spotlight', 'events'].includes(s.eggsLayout), hint: 'Vertical = YouTube Shorts / Kick mobile live' },
    { k: 'eggsPopup', t: 'range', label: 'Show each for', min: 0, max: 120, step: 1, show: (s) => s.eggsLayout === 'alert', fmt: (v) => (v === 0 ? 'Always (latest stays)' : `${v} s, then hide`), hint: 'Several at once (e.g. an event + 2 eggs) show one after another' },
    { k: 'eggsPopup', t: 'range', label: 'Pop up', min: 0, max: 120, step: 5, show: (s) => ['spotlight', 'events'].includes(s.eggsLayout), fmt: (v) => (v === 0 ? 'Always visible' : `${v} s per spawn`), hint: 'Shows only when a new egg / event arrives, then hides (the preview stays visible)' },
    { k: 'eggsFit', t: 'toggle', label: 'Fit to screen', show: (s) => s.eggsLayout !== 'alert', hint: 'OBS: everything (events, Secret, Eternal, Divine …) always fits the source, at any resolution' },
    { k: 'eggsColumns', t: 'range', label: 'Columns', min: 1, max: 6, show: (s) => ['board', 'grouped'].includes(s.eggsLayout), hint: 'Tiles / panels per row (Fit to screen adds columns on wide screens)' },
  ] },
  { tab: 'content', title: 'Eggs', types: ['eggs'], fields: [
    { k: 'eggsCount', t: 'range', label: 'How many eggs', min: 1, max: 40, show: (s) => s.eggsLayout !== 'board' },
    { k: 'eggsTiles', t: 'range', label: 'Eggs per rarity', min: 1, max: 80, show: (s) => s.eggsLayout === 'board', hint: 'Board shows every egg ever seen, newest first' },
    { k: 'eggsLatest', t: 'toggle', label: 'Latest egg highlight', hint: 'Board: LIVE NOW / LATEST pill per rarity. List: a big glowing card' },
    { k: 'eggsTitle', t: 'text', label: 'List title', placeholder: 'Latest eggs', show: (s) => s.eggsLayout === 'list' },
    { k: 'eggsLocation', t: 'toggle', label: 'Show location', show: (s) => s.eggsLayout !== 'grouped' },
    { k: 'eggsDetails', t: 'toggle', label: 'Money & speed' },
  ] },
  { tab: 'layout', title: 'On screen', types: ['alerts'], fields: [
    { k: 'eggsPopup', t: 'range', label: 'Time on screen', min: 0, max: 60, fmt: (v) => (v === 0 ? 'Always (latest stays)' : `${v} s, then hide`), hint: 'Each alert stays this long, then hides. Several at once show one after another' },
    { k: 'fontSize', t: 'range', label: 'Text size', min: 10, max: 48, unit: 'px', hint: 'Makes the whole alert bigger or smaller' },
  ] },
  { tab: 'layout', title: 'Alert look', types: ['eggs', 'alerts'], fields: [
    { k: 'eggsAlertStyle', t: 'select', label: 'Style', show: isAlert, options: [['card', 'Card (glowing)'], ['banner', 'Banner (slim bar)'], ['toast', 'Toast (compact pill)'], ['neon', 'Neon'], ['glass', 'Glass'], ['minimal', 'Minimal (no background)'], ['big', 'Big (centered)']] },
    { k: 'eggsAlertPos', t: 'seg', label: 'Position', show: isAlert, options: [['top', 'Top'], ['center', 'Center'], ['bottom', 'Bottom']] },
    { k: 'animation', t: 'select', label: 'Entry animation', show: isAlert, options: ANIM_OPTIONS },
    { k: 'animSpeed', t: 'seg', label: 'Speed', show: isAlert, options: [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']] },
    { k: 'eggsEggLabel', t: 'text', label: 'Egg label', types: ['eggs'], show: isAlert, placeholder: '{rarity} egg spawned', hint: '{rarity} becomes Secret, Eternal, Divine …' },
    { k: 'eggsEventLabel', t: 'text', label: 'Event label', types: ['eggs'], show: isAlert, placeholder: '⚡ EVENT' },
  ] },
  { tab: 'layout', title: 'Sound', types: ['alerts'], fields: [
    { k: 'alertSound', t: 'toggle', label: 'Sounds', hint: 'Every alert kind has its own sound (change it per alert in “Which alerts”). In OBS tick “Control audio via OBS”' },
    { k: 'alertVolume', t: 'range', label: 'Volume', min: 0, max: 100, unit: '%', show: (s) => s.alertSound },
  ] },
  { tab: 'content', title: 'All alerts', types: ['alerts'], fields: [
    { k: 'alertMessage', t: 'toggle', label: 'Show the viewer’s message' },
    { k: 'alertCount', t: 'toggle', label: 'Count badge', hint: '“#3 this stream” on Super Chats, members, subs, follows …' },
  ] },
  ALERT_EDIT_GROUP,
  { tab: 'content', title: 'Goal', types: ['goal'], fields: [
    { k: 'goalType', t: 'seg', label: 'Count', options: [['youtube-subs', 'YouTube subs'], ['kick-followers', 'Kick followers'], ['combined', 'Both']] },
    { k: 'goalTarget', t: 'number', label: 'Target', min: 1, max: 100000000 },
    { k: 'goalTitle', t: 'text', label: 'Title', placeholder: 'Subscriber goal' },
    { k: 'goalStyle', t: 'seg', label: 'Look', options: [['bar', 'Thick bar'], ['slim', 'Slim bar']] },
    { k: 'goalNumbers', t: 'toggle', label: 'Show numbers' },
    { k: 'goalPercent', t: 'toggle', label: 'Show percent' },
  ] },
  { tab: 'layout', title: 'Donate layout', types: ['donate'], fields: [
    { k: 'donateLayout', t: 'seg', label: 'Layout style', options: [['card', 'Card (side-by-side)'], ['stacked', 'Stacked (centered)'], ['qr-only', 'Scanner only']], rebuild: true, hint: 'Scanner only displays just the QR code (and optional UPI beneath) — ideal for clean OBS overlays' },
    { k: 'donateQrSize', t: 'range', label: 'Scanner size', min: 80, max: 320, step: 10, fmt: (v) => `${v}px` },
    { k: 'donateUpiPos', t: 'seg', label: 'UPI ID position', options: [['side', 'Beside scanner'], ['below-qr', 'Below scanner']], show: (s) => s.donateShowUpi && s.donateLayout !== 'qr-only', hint: 'Show your UPI ID directly underneath the QR code box or beside it' },
  ] },
  { tab: 'content', title: 'Donate box', types: ['donate'], fields: [
    { k: 'donateShowTitle', t: 'toggle', label: 'Show title', rebuild: true },
    { k: 'donateTitle', t: 'text', label: 'Title text', placeholder: 'Support the stream 💜', show: (s) => s.donateShowTitle !== false },
    { k: 'donateShowSub', t: 'toggle', label: 'Show instructions / subtitle', hint: '“Scan with your phone camera to donate”' },
    { k: 'donateShowUpi', t: 'toggle', label: 'Show UPI ID', rebuild: true },
    { k: 'donateShowLink', t: 'toggle', label: 'Show donation page link' },
    { k: 'donateQr', t: 'seg', label: 'QR code opens', options: [['page', 'My donation page'], ['upi', 'UPI app directly']], hint: 'Donation page = viewer adds name + message and you get a note to confirm. UPI direct = no note, add it by hand on the Donations page' },
    { t: 'action', icon: 'heart', label: 'Set up UPI & see donations', run: () => { location.hash = 'donations'; } },
  ] },
  { tab: 'content', title: 'Poll', types: ['poll'], fields: [
    { k: 'pollHideIdle', t: 'toggle', label: 'Hide when no poll', hint: 'Appears when you start a poll in Live tools, hides 60 s after it ends' },
    { k: 'pollHint', t: 'toggle', label: 'Show “Type !vote 1–3”' },
  ] },
  { tab: 'content', title: 'Game events', types: ['eggs'], fields: [
    { k: 'eggsEvents', t: 'toggle', label: 'Show events', show: (s) => s.eggsLayout !== 'events', hint: 'Tidal Surge, Butterfly Bloom, Slick Rick … from the Discord feed' },
    { k: 'eggsEventsCount', t: 'range', label: 'How many events', min: 1, max: 10 },
    { k: 'eggsEventDetails', t: 'toggle', label: 'Event details', hint: 'Summary + possible eggs / what it sells' },
  ] },
  { tab: 'content', title: 'Freshness', types: ['eggs'], fields: [
    { k: 'eggsNewMinutes', t: 'range', label: 'Highlight new for', min: 0, max: 60, fmt: (v) => (v === 0 ? 'Off' : `${v} min`) },
    { k: 'eggsMaxAge', t: 'range', label: 'Hide older than', min: 0, max: 720, step: 15, fmt: (v) => (v === 0 ? 'Never' : v < 60 ? `${v} min` : `${(v / 60).toFixed(v % 60 ? 1 : 0)} h`) },
  ] },
  { tab: 'layout', title: 'Stats layout', types: ['stats'], fields: [
    { k: 'statsLayout', t: 'seg', label: 'Style', options: [['row', 'Row'], ['column', 'Column'], ['pill', 'Pill']] },
    { k: 'statsAlign', t: 'seg', label: 'Align', options: [['left', 'Left'], ['center', 'Center']] },
  ] },
];

// ── autosave ──
let saveTimer = null;
function saveState(text, cls = '') {
  const s = $('#save-state');
  s.className = 'save-state ' + cls;
  s.replaceChildren(...(cls === 'ok' ? [ic('check')] : []), text);
}
function scheduleSave() {
  if (!current) return;
  saveState('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 450);
}
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!current) return;
  try {
    const w = await api(`/api/widgets/${current.id}`, { method: 'PUT', body: JSON.stringify({ name: current.name, settings }) });
    Object.assign(current, w);
    saveState('Saved', 'ok');
  } catch (e) {
    saveState('Not saved', 'err');
    toast(e.message, 'err');
  }
}
function set(k, v, { rebuild = false } = {}) {
  settings[k] = v;
  scheduleSave();
  refreshPreview();
  if (rebuild) renderConfig();
}

function control(f) {
  const v = settings[f.k];
  switch (f.t) {
    case 'color': {
      const text = h('input', { type: 'text', value: v, maxlength: 7, 'aria-label': f.label });
      const pick = h('input', { type: 'color', value: v, 'aria-label': f.label });
      pick.addEventListener('input', () => { text.value = pick.value; set(f.k, pick.value); });
      text.addEventListener('change', () => {
        const c = (text.value.startsWith('#') ? text.value : '#' + text.value).toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(c)) { pick.value = c; set(f.k, c); } else text.value = settings[f.k];
      });
      return h('div', { class: 'color' }, pick, text);
    }
    case 'range': {
      const label = (n) => (f.fmt ? f.fmt(n) : `${n}${f.unit || ''}`);
      const out = h('span', { class: 'val' }, label(v));
      const r = h('input', { type: 'range', min: f.min, max: f.max, step: f.step || 1, value: v, 'aria-label': f.label });
      r.addEventListener('input', () => { out.textContent = label(Number(r.value)); set(f.k, Number(r.value)); });
      return [r, out];
    }
    case 'toggle': {
      const i = h('input', { type: 'checkbox', 'aria-label': f.label });
      i.checked = !!v;
      i.addEventListener('change', () => set(f.k, i.checked));
      return h('span', { class: 'switch' }, i, h('span'));
    }
    case 'select': {
      const sel = h('select', { class: 'select', 'aria-label': f.label }, f.options.map(([val, label]) => {
        const o = h('option', { value: val }, label);
        if (String(val) === String(v)) o.selected = true;
        return o;
      }));
      sel.addEventListener('change', () => set(f.k, f.num ? Number(sel.value) : sel.value, { rebuild: !!f.rebuild }));
      return sel;
    }
    case 'seg':
      return h('div', { class: 'seg full', role: 'group', 'aria-label': f.label }, f.options.map(([val, label]) =>
        h('button', { type: 'button', class: val === v ? 'on' : '', onclick: () => set(f.k, val, { rebuild: true }) }, label)));
    case 'kindpick': {
      const sel = h('select', { class: 'select', 'aria-label': f.label }, ALERT_KINDS.map(([K]) => {
        const off = settings[`alert${K}`] === false;
        return h('option', { value: K, selected: K === editKind ? true : undefined }, `${KIND_INFO[K][1]}${off ? '  (off)' : ''}`);
      }));
      sel.addEventListener('change', () => { editKind = sel.value; const t = $('#test-kind'); if (t) t.value = typeOfKind(editKind); renderConfig(); });
      return h('div', { class: 'kindpick' }, h('span', { class: 'kind-ic', html: icon(KIND_ICON[editKind] || 'bell') }), sel);
    }
    case 'upload': {
      const url = mediaUrl(v);
      const input = h('input', { type: 'file', accept: f.accept, hidden: true });
      const status = h('span', { class: 'muted tiny' });
      const preview = !url ? h('span', { class: 'muted tiny' }, 'Nothing uploaded')
        : f.kind === 'image' ? h('img', { class: 'up-img', src: url, alt: '' })
          : h('button', { type: 'button', class: 'btn sm', onclick: () => { try { const a = new Audio(url); a.volume = (settings.alertVolume ?? 60) / 100; a.play(); } catch { /* ignore */ } } }, ic('play'), 'Play my sound');
      const pick = h('button', { type: 'button', class: 'btn sm primary', onclick: () => input.click() }, ic('upload'), url ? 'Replace' : 'Upload');
      const remove = url ? h('button', { type: 'button', class: 'btn sm ghost', onclick: async () => {
        const id = (v.match(/\/api\/media\/([\w-]+)$/) || [])[1];
        set(f.k, '', { rebuild: true });
        if (id) api(`/api/media/${id}`, { method: 'DELETE' }).catch(() => {});
      } }, ic('trash'), 'Remove') : null;
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) { toast('File is too big (max 3 MB)', 'err'); return; }
        status.textContent = 'Uploading…';
        try {
          const r = await fetch(`/api/media?kind=${f.kind}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
          const old = (String(v || '').match(/\/api\/media\/([\w-]+)$/) || [])[1];
          set(f.k, j.url, { rebuild: true });
          if (old) api(`/api/media/${old}`, { method: 'DELETE' }).catch(() => {});
          toast('Uploaded');
        } catch (e) { status.textContent = ''; toast(e.message, 'err'); }
      });
      return h('div', { class: 'upload' }, h('div', { class: 'up-prev' }, preview), h('div', { class: 'row' }, pick, remove, status), input);
    }
    case 'number': {
      const i = h('input', { class: 'input', type: 'number', min: f.min, max: f.max, step: 1, value: v, 'aria-label': f.label });
      i.addEventListener('input', () => { const n = Math.round(Number(i.value)); if (Number.isFinite(n) && n >= (f.min ?? 0) && n <= (f.max ?? Infinity)) set(f.k, n); });
      return i;
    }
    case 'text': {
      const i = h('input', { class: 'input', type: 'text', value: v, placeholder: f.placeholder || '', maxlength: 500, 'aria-label': f.label });
      i.addEventListener('input', () => set(f.k, i.value));
      return i;
    }
    default:
      return null;
  }
}

const SAMPLE = {
  id: 'sample', platform: 'youtube', kind: 'chat', ts: Date.now(),
  author: { name: 'PixelPanda', avatar: null, color: null, badges: [{ type: 'moderator', label: 'Moderator' }] },
  parts: [{ type: 'text', text: 'This overlay looks clean 🔥' }],
};
const LOOK_KEYS = ['font', 'fontSize', 'fontWeight', 'textColor', 'msgBg', 'msgBgOpacity', 'accent', 'nameColor', 'radius', 'showAvatar', 'stroke'];

function themeGallery() {
  const grid = h('div', { class: 'theme-grid' });
  for (const t of THEMES) {
    const s = { ...DEFAULTS, ...t.values, theme: t.id, fontSize: 11, padding: 7, pageBgOpacity: 0 };
    const mini = document.createElement('div');
    applyRoot(mini, s, 'chat');
    mini.append(createMessageEl(SAMPLE, s));
    grid.append(h('button', {
      type: 'button', class: 'theme-card' + (settings.theme === t.id ? ' on' : ''), 'aria-pressed': String(settings.theme === t.id),
      onclick: () => {
        for (const k of LOOK_KEYS) settings[k] = k in t.values ? t.values[k] : DEFAULTS[k];
        settings.theme = t.id;
        scheduleSave();
        renderConfig();
        refreshPreview();
      },
    }, h('div', { class: 'tc-preview' }, mini), h('div', { class: 'tc-meta' }, h('b', {}, t.name), h('span', {}, t.desc))));
  }
  return grid;
}

/** One setting row. Layout depends on the control so text never overflows. */
function fieldEl(f) {
  const hint = f.hint ? h('small', { class: 'fld-hint' }, f.hint) : null;
  if (f.t === 'toggle') {
    return h('label', { class: 'fld fld-toggle' }, h('span', { class: 'fld-txt' }, h('b', {}, f.label), hint), control(f));
  }
  if (f.t === 'range') {
    const [slider, out] = control(f);
    return h('div', { class: 'fld' }, h('div', { class: 'fld-row' }, h('b', {}, f.label), out), slider, hint);
  }
  if (f.t === 'action') {
    return h('div', { class: 'fld' }, h('button', { type: 'button', class: 'btn sm', onclick: f.run }, f.icon ? ic(f.icon) : null, f.label));
  }
  if (f.t === 'quick') {
    return h('div', { class: 'fld' }, h('div', { class: 'quick' },
      h('button', { type: 'button', class: 'btn sm', onclick: () => { Object.assign(settings, { pageBgOpacity: 0, msgBgOpacity: 0, stroke: true }); scheduleSave(); refreshPreview(); renderConfig(); } }, ic('sparkles'), 'Fully transparent'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { settings.pageBgOpacity = 0; scheduleSave(); refreshPreview(); renderConfig(); } }, 'Transparent background only')));
  }
  return h('div', { class: 'fld' }, h('b', { class: 'fld-label' }, f.label), control(f), hint);
}

/** Settings keys that belong to one Studio section (for its Reset button). */
function sectionKeys(id, type) {
  if (id === 'theme') return ['theme', ...LOOK_KEYS];
  const keys = [];
  for (const g of GROUPS) {
    if (g.tab !== id || (g.types && !g.types.includes(type))) continue;
    for (const f of g.fields) if (f.k && !(f.types && !f.types.includes(type))) keys.push(f.k);
  }
  return keys;
}
async function resetSection(id, title, type) {
  if (!(await dialog({ title: `Reset ${title}?`, text: `Only the ${title} settings go back to default. Everything else stays as it is.`, confirm: `Reset ${title}` }))) return;
  for (const k of sectionKeys(id, type)) settings[k] = DEFAULTS[k];
  scheduleSave();
  renderConfig();
  refreshPreview();
  toast(`${title} reset`);
}

function sectionBody(id, type) {
  const out = [];
  if (id === 'theme') {
    out.push(h('p', { class: 'fld-hint', style: 'margin:10px 0 12px' }, 'Pick a starting point, then fine-tune it in Style. Your other settings are kept.'), themeGallery());
  }
  for (const g of GROUPS) {
    if (g.tab !== id || (g.types && !g.types.includes(type))) continue;
    const fields = g.fields.filter((f) => !(f.types && !f.types.includes(type)) && !(f.show && !f.show(settings)));
    if (!fields.length) continue; // e.g. "Alert look" when the layout isn't Alert
    out.push(h('div', { class: 'sub' }, h('div', { class: 'sub-title' }, g.title), fields.map(fieldEl)));
  }
  return out;
}

function renderConfig() {
  const type = current?.type || 'chat';
  const tabs = TABS[type];
  if (studioTab && !tabs.some(([id]) => id === studioTab)) studioTab = 'theme';
  const body = $('#config-body');
  const scroll = body.scrollTop;
  body.replaceChildren();

  for (const [id, title, ico] of tabs) {
    const open = studioTab === id;
    const [desc] = SECTION_INFO[id](type);
    const sec = h('section', { class: 'acc' + (open ? ' open' : '') });
    const head = h('button', {
      type: 'button', class: 'acc-head', 'aria-expanded': String(open), 'aria-controls': `acc-${id}`,
      onclick: () => {
        studioTab = open ? null : id; // one section open at a time
        renderConfig();
        if (!open) requestAnimationFrame(() => $(`#acc-${id}`)?.parentElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      },
    },
    h('span', { class: 'acc-ic', html: icon(ico) }),
    h('span', { class: 'acc-txt' }, h('b', {}, title), h('span', {}, desc)),
    h('span', { class: 'acc-chev', html: icon('chevron') }));
    sec.append(head);
    if (open) {
      sec.append(h('div', { class: 'acc-body', id: `acc-${id}`, role: 'region' }, sectionBody(id, type),
        h('div', { class: 'acc-reset' }, h('button', { type: 'button', class: 'btn sm ghost', onclick: () => resetSection(id, title, type) }, ic('refresh'), `Reset ${title}`))));
    }
    body.append(sec);
  }

  body.append(h('div', { class: 'acc-actions' },
    h('button', { type: 'button', class: 'btn sm', onclick: resetWidget }, ic('refresh'), 'Reset everything'),
    h('button', { type: 'button', class: 'btn sm danger', onclick: deleteWidget }, ic('trash'), 'Delete widget')));
  body.scrollTop = scroll;
}

let wselOpen = false;
function renderWidgetPicker() {
  const meta = (t) => TYPE_META[t] || TYPE_META.chat;
  const order = Object.keys(TYPE_META);
  const sorted = [...widgets].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const item = (w, cls) => [h('span', { class: `wsel-ic t-${w.type}`, html: icon(meta(w.type)[1]) }), h('span', { class: 'wsel-txt' }, h('b', {}, w.name), h('small', {}, meta(w.type)[2])), cls];
  const btn = h('button', { type: 'button', class: 'wsel-btn', 'aria-haspopup': 'listbox', 'aria-expanded': String(wselOpen), 'aria-label': 'Choose widget',
    onclick: (e) => { e.stopPropagation(); wselOpen = !wselOpen; renderWidgetPicker(); } }, current ? item(current, null) : 'Widget', h('span', { class: 'wsel-chev', html: icon('chevron') }));
  const menu = wselOpen ? h('ul', { class: 'wsel-menu', role: 'listbox' }, sorted.map((w) => h('li', {
    role: 'option', 'aria-selected': String(w.id === current?.id), class: w.id === current?.id ? 'on' : '', tabindex: 0,
    onclick: (e) => { e.stopPropagation(); wselOpen = false; selectWidget(w.id); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); wselOpen = false; selectWidget(w.id); } },
  }, item(w, w.id === current?.id ? h('span', { class: 'wsel-check', html: icon('check') }) : null)))) : null;
  $('#widget-select').replaceChildren(btn, menu || '');
  $('#widget-name').value = current?.name || '';
  $('#nav-widgets').textContent = widgets.length;
}

function selectWidget(id) {
  if (current && saveTimer) saveNow();
  current = widgets.find((w) => w.id === id) || widgets[0] || null;
  if (!current) return;
  try { localStorage.setItem('omnichat.widget', current.id); } catch { /* ignore */ }
  settings = normalizeSettings(current.settings);
  $('#chat-frame').hidden = current.type !== 'chat';
  $('#stats-frame').hidden = current.type !== 'stats';
  $('#eggs-frame').hidden = current.type !== 'eggs';
  for (const t of ['alerts', 'goal', 'poll', 'donate']) $(`#${t}-frame`).hidden = current.type !== t;
  renderTestBar();
  renderTypeHelp();
  saveState('');
  renderWidgetPicker();
  renderConfig();
  refreshPreview();
}

async function newWidget() {
  const TYPE_DESC = { chat: 'YouTube + Kick chat in one box', stats: 'Viewers, subs & followers', eggs: 'Steal an Egg spawns & events', alerts: 'Super Chats, members, subs, donations', goal: 'Progress bar to a target', poll: 'Live !vote results', donate: 'Your UPI QR code on stream' };
  const picker = h('div', { class: 'type-cards', 'data-value': 'chat', role: 'radiogroup' },
    Object.entries(TYPE_META).map(([t, [, ico, label]]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(t === 'chat'), class: 'type-card' + (t === 'chat' ? ' on' : ''), 'data-v': t },
      h('span', { class: `wsel-ic t-${t}`, html: icon(ico) }), h('span', { class: 'wsel-txt' }, h('b', {}, label), h('small', {}, TYPE_DESC[t] || '')))));
  picker.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    picker.dataset.value = b.dataset.v;
    $$('button', picker).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
  });
  const type = await dialog({ title: 'New widget', text: 'Each widget gets its own URL and design. Use several for different scenes.', confirm: 'Create widget', content: picker });
  if (!type) return;
  try {
    const n = widgets.filter((x) => x.type === type).length + 1;
    // Eggs overlay starts from a dark "stock board" look (like an in-game notifier panel).
    const preset = WIDGET_PRESETS[type] && Object.keys(WIDGET_PRESETS[type]).length ? { ...DEFAULTS, ...WIDGET_PRESETS[type] } : null;
    const startSettings = preset || (current && current.type === type ? settings : {});
    const w = await api('/api/widgets', { method: 'POST', body: JSON.stringify({ type, name: `${TYPE_META[type][2]} ${n}`, settings: startSettings }) });
    widgets.push(w);
    selectWidget(w.id);
    toast('Widget created');
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteWidget() {
  if (!current) return;
  if (widgets.length <= 1) return toast('Keep at least one widget', 'err');
  if (!(await dialog({ title: `Delete “${current.name}”?`, text: 'Its URL stops working immediately in OBS and every overlay app.', confirm: 'Delete', danger: true }))) return;
  try {
    await api(`/api/widgets/${current.id}`, { method: 'DELETE' });
    widgets = widgets.filter((w) => w.id !== current.id);
    current = null;
    selectWidget(widgets[0].id);
    toast('Widget deleted');
  } catch (e) { toast(e.message, 'err'); }
}

async function resetWidget() {
  if (!(await dialog({ title: 'Reset this widget?', text: 'All design settings go back to the defaults. The URL stays the same.', confirm: 'Reset' }))) return;
  settings = { ...DEFAULTS };
  scheduleSave();
  renderConfig();
  refreshPreview();
}

async function rotateWidget() {
  if (!current) return;
  if (!(await dialog({ title: 'Generate a new URL?', text: 'Use this if your widget link was shared by mistake. The old URL stops working right away — update it in OBS afterwards.', confirm: 'Generate new URL', danger: true }))) return;
  try {
    if (saveTimer) await saveNow();
    const w = await api(`/api/widgets/${current.id}/rotate`, { method: 'POST' });
    const i = widgets.findIndex((x) => x.id === current.id);
    widgets[i] = w;
    current = w;
    renderWidgetPicker();
    refreshPreview();
    toast('New URL generated — copy it into OBS');
  } catch (e) { toast(e.message, 'err'); }
}

// ── preview ──
const chatView = new ChatView($('#chat-preview'), settings);
const statsView = new StatsView($('#stats-preview'), settings);
const eggsView = new EggsView($('#eggs-preview'), settings);
eggsView.preview = true; // popup mode would hide the Studio preview
const alertsView = new AlertsView($('#alerts-preview'), settings);
alertsView.preview = true;
const goalView = new GoalView($('#goal-preview'), settings);
const pollView = new PollView($('#poll-preview'), settings);
const donateView = new DonateView($('#donate-preview'), settings);
donateView.preview = true;
async function loadDonatePreview() { try { const r = await api('/api/tools/donate'); donateView.setData(r.settings.enabled && r.settings.upi ? { id: me.user.id, name: r.settings.payee || me.user.name, upi: r.settings.upi, link: `upi://pay?pa=${encodeURIComponent(r.settings.upi)}&pn=${encodeURIComponent(r.settings.payee || me.user.name || 'Streamer')}&cu=INR` } : demoDonate()); } catch { donateView.setData(demoDonate()); } }
pollView.preview = true;
let alertDemo = null;
// Studio: test one alert kind in the preview (with its sound), optionally also in OBS
const TEST_BUTTONS = [['superchat', 'Super Chat'], ['member', 'New member'], ['gift', 'Gift'], ['sub', 'Kick sub'], ['follow', 'Follow'], ['greeting', 'Said hi'], ['highlight', 'Highlight'], ['donation', 'Donation']];
function testAlert(type) {
  alertDemo?.stop(); alertDemo = null; // stop the automatic demo so the test stays visible
  alertsView.test(type);
}
function renderTestBar() {
  const bar = $('#alert-tests');
  bar.hidden = current?.type !== 'alerts';
  if (bar.hidden) return;
  const sel = h('select', { class: 'select', id: 'test-kind', 'aria-label': 'Alert to test' }, TEST_BUTTONS.map(([t, label]) => h('option', { value: t }, label)));
  sel.value = typeOfKind(editKind);
  bar.replaceChildren(
    h('b', { class: 'tiny' }, 'Test alert'), sel,
    h('button', { type: 'button', class: 'btn sm', onclick: () => testAlert(sel.value) }, ic('play'), 'Preview here'),
    h('button', { type: 'button', class: 'btn sm primary', onclick: () => sendTestToObs(sel.value) }, ic('radio'), 'Send to OBS'),
    h('span', { class: 'muted tiny' }, 'OBS: the widget URL must be open (OBS or a browser tab).'));
}
async function sendTestToObs(type) {
  testAlert(type);
  try { await api('/api/tools/test-alert', { method: 'POST', body: JSON.stringify({ type }) }); toast('Sent — it shows on your widget URL within ~3 s'); } catch (e) { toast(e.message, 'err'); }
}
const TYPE_HELP = {
  chat: ['Chat overlay', 'Your YouTube + Kick chat in one box.', 'OBS → Sources → Browser → paste the URL · 400 × 700'],
  stats: ['Stats', 'Live viewers, subscribers and followers.', 'OBS Browser source · about 800 × 140'],
  eggs: ['Egg tracker', 'Steal an Egg spawns and game events from Discord. Layout → Alert pops one up at a time.', 'OBS Browser source · size shown above the preview'],
  alerts: ['Alerts', 'Pops up for Super Chats, new members, gifts, Kick subs & follows, UPI donations and messages you highlight. 1) Which alerts → turn kinds on/off, text, sound, own picture  2) Look & timing → time on screen, size, style  3) Test with the buttons under the preview.', 'OBS Browser source · 900 × 260 · tick “Control audio via OBS” for sounds'],
  goal: ['Goal', 'Progress bar to a subscriber / follower target. Set the target in Goal.', 'OBS Browser source · 700 × 120'],
  poll: ['Poll', 'Shows your chat poll live and hides when there is none. Start polls in Live tools → Chat poll.', 'OBS Browser source · 520 × 360'],
  donate: ['Donate QR', 'Your UPI QR code on stream so viewers can scan and donate. Set your UPI ID on the Donations page (Demo shows a sample).', 'OBS Browser source · 520 × 200'],
};
function renderTypeHelp() {
  const [title, what, obs] = TYPE_HELP[current?.type] || TYPE_HELP.chat;
  $('#type-help').replaceChildren(h('span', { class: 'th-ic', html: icon((TYPE_META[current?.type] || TYPE_META.chat)[1]) }),
    h('div', { class: 'th-txt' }, h('b', {}, title), h('span', {}, what), h('span', { class: 'muted' }, obs)));
}
let livePollTimer = null;
async function loadLivePoll() { try { const r = await api('/api/tools'); pollView.setPoll(r.poll || demoPoll()); } catch { /* keep */ } }
/** OBS size for the eggs widget (spotlight/events depend on stream orientation). */
const eggsSize = (s) => ({
  list: '420 × 700', board: '1000 × 1000', grouped: '1200 × 700',
  alert: s.eggsOrient === 'vertical' ? '420 × 520' : '900 × 220',
  spotlight: s.eggsOrient === 'vertical' ? '420 × 760' : '1100 × 300',
  events: s.eggsOrient === 'vertical' ? '420 × 700' : '1100 × 260',
}[s.eggsLayout] || '1200 × 700');
let eggDemo = null;
let eggLiveTimer = null;
async function loadLiveEggs() {
  try { const r = await api('/api/eggs'); eggsView.setSeen(r.seen || [], false); eggsView.setEvents(r.events || []); eggsView.setItems(r.items || []); } catch { /* keep last */ }
}

function refreshPreview() {
  chatView.setSettings({ ...settings });
  statsView.setSettings({ ...settings });
  eggsView.setSettings({ ...settings });
  alertsView.setSettings({ ...settings });
  goalView.setSettings({ ...settings });
  pollView.setSettings({ ...settings });
  donateView.setSettings({ ...settings });
  if (feedMode === 'live') { statsView.setState(liveState || {}); goalView.setState(liveState || {}); }
  const url = current ? widgetUrl(current) : '';
  $('#url').value = url;
  $('#open').href = url || '#';
  $('#size-hint').textContent = current?.type === 'stats' ? (settings.statsLayout === 'column' ? '320 × 300' : '800 × 140')
    : current?.type === 'eggs' ? eggsSize(settings)
      : current?.type === 'alerts' ? (settings.eggsAlertStyle === 'big' ? '900 × 500' : '900 × 260')
        : current?.type === 'goal' ? '700 × 120' : current?.type === 'poll' ? '520 × 360' : current?.type === 'donate' ? (settings.donateLayout === 'qr-only' ? '240 × 260' : settings.donateLayout === 'stacked' ? '320 × 380' : '520 × 200') : '400 × 700';
  for (const [t, size] of [['alerts', '900 × 260'], ['goal', '700 × 120'], ['poll', '520 × 360'], ['donate', settings.donateLayout === 'qr-only' ? '240 × 260' : settings.donateLayout === 'stacked' ? '320 × 380' : '520 × 200']]) $(`#${t}-frame`).dataset.size = `${t === 'alerts' && settings.eggsAlertStyle === 'big' ? '900 × 500' : size} · OBS size`;
  $('#eggs-frame').dataset.size = `${eggsSize(settings)} · OBS size`;
  $('#eggs-frame').classList.toggle('wide', settings.eggsLayout !== 'list' && settings.eggsOrient !== 'vertical');
}

function setFeed(mode) {
  feedMode = mode;
  demo?.stop();
  demo = null;
  chatView.clear();
  eggDemo?.stop();
  clearInterval(eggLiveTimer);
  alertDemo?.stop();
  clearInterval(livePollTimer);
  if (mode === 'demo') { alertDemo = startAlertDemo((m) => alertsView.add(m), 5000); goalView.setState(demoGoalState()); pollView.setPoll(demoPoll()); donateView.setData(demoDonate()); }
  else { loadDonatePreview(); goalView.setState(liveState || {}); loadLivePoll(); livePollTimer = setInterval(loadLivePoll, 3000); }
  if (mode === 'demo') eggsView.setSeen([], false);
  if (mode === 'demo') eggDemo = startEggDemo((list) => eggsView.setItems(list), 6000, (list) => eggsView.setEvents(list));
  else { loadLiveEggs(); eggLiveTimer = setInterval(loadLiveEggs, 10_000); }
  if (mode === 'demo') demo = startDemo({ onChat: (m) => chatView.add(m), onState: (st) => statsView.setState(st), platforms: () => ['youtube', 'kick'].filter((p) => settings[p]) });
  else { chatView.setHistory(liveHistory); statsView.setState(liveState || {}); }
  $$('#feed-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
}

// ═════════════════════════════════════════════════════════════════════
//  Status pills (topbar)
// ═════════════════════════════════════════════════════════════════════
function pill(el, cls, text, title = '') {
  el.className = 'pill ' + cls;
  el.title = title;
  el.replaceChildren(h('span', { class: 'dot' }), text);
}
function renderStatus() {
  pill($('#pill-server'), serverOk ? 'ok' : 'bad', serverOk ? 'Connected' : 'Reconnecting…');
  const st = liveState;
  if (!st) return;
  const yt = st.youtube;
  if (!yt.connected) pill($('#pill-youtube'), '', 'YouTube · not linked');
  else if (yt.live) pill($('#pill-youtube'), 'live', `YouTube LIVE · ${fmtN(yt.viewers)}`, yt.title || '');
  else pill($('#pill-youtube'), yt.error ? 'warn' : 'ok', 'YouTube · offline', yt.error || '');
  const k = st.kick;
  if (!k.connected) pill($('#pill-kick'), '', 'Kick · not linked');
  else if (k.live) pill($('#pill-kick'), 'live', `Kick LIVE · ${fmtN(k.viewers)}`, k.title || '');
  else pill($('#pill-kick'), k.error ? 'warn' : 'ok', 'Kick · offline', k.error || '');
  $('#nav-live').hidden = !(yt.live || k.live);
}

// ═════════════════════════════════════════════════════════════════════
//  Overview
// ═════════════════════════════════════════════════════════════════════
let ov = null;
let msgCounts = null;

function kpi(iconHtml, label) {
  const val = h('div', { class: 'kpi-val' }, '—');
  const foot = h('div', { class: 'kpi-foot' });
  const card = h('div', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, h('div', { class: 'kpi-ic', html: iconHtml }), label), val, foot);
  return { card, val, foot };
}

function renderOverview() {
  const root = $('#page-overview');
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  ov = {
    yt: kpi(ICONS.youtube, 'YouTube'),
    kk: kpi(ICONS.kick, 'Kick'),
    tot: kpi(icon('eye'), 'Watching now'),
    msgs: kpi(icon('message'), 'Chat messages · 24h'),
  };

  const hero = h('div', { class: 'card hero' },
    h('div', {}, h('h2', {}, `${greet}, ${me.user.name || 'streamer'}`),
      h('p', {}, 'Your overlays are ready. Open Studio to tweak the look, or copy a URL straight into OBS.')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: showWhatsNewModal }, ic('sparkles'), "What's new"),
      h('button', { class: 'btn creator-hero-btn', type: 'button', onclick: showCreatorModal }, ic('coffee'), 'Support SmartWolf ☕'),
      h('a', { class: 'btn', href: '#connections' }, ic('plug'), 'Connections'),
      h('a', { class: 'btn primary', href: '#studio' }, ic('palette'), 'Open Studio')));

  const has = (p) => me.accounts.some((a) => a.provider === p);
  const kickAcc = me.accounts.find((a) => a.provider === 'kick');
  const designed = widgets.some((w) => w.settings && Object.keys(w.settings).length && w.settings.theme !== undefined && JSON.stringify(normalizeSettings(w.settings)) !== JSON.stringify(DEFAULTS));
  const steps = [
    [has('youtube'), 'Connect YouTube', 'Chat, viewers and subscribers', '#connections'],
    [has('kick'), 'Connect Kick', 'Chat, viewers and followers', '#connections'],
    [!has('kick') || kickAcc?.followers != null || liveState?.kick?.followers != null, 'Kick followers', 'Synced automatically when you open the dashboard', '#connections'],
    [designed, 'Design your overlay', 'Pick a theme in Studio', '#studio'],
  ];
  const doneCount = steps.filter((s) => s[0]).length;
  const checklist = doneCount < steps.length ? h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Getting started'), h('span', { class: 'sub' }, `${doneCount} of ${steps.length} done`)),
    h('ul', { class: 'checklist' }, steps.map(([done, title, sub, href]) =>
      h('li', { class: done ? 'done' : '' }, h('span', { class: 'check', html: icon('check') }),
        h('div', { class: 'txt' }, h('b', {}, title), h('span', {}, sub)),
        done ? null : h('a', { class: 'btn sm', href }, 'Set up'))))) : null;

  const wl = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Your widgets'), h('span', { class: 'sub' }, 'Paste these into OBS'),
      h('div', { class: 'actions' }, h('a', { class: 'btn sm', href: '#studio' }, ic('palette'), 'Studio'))),
    h('ul', { class: 'wlist' }, widgets.map((w) => h('li', { class: 'wrow' },
      h('div', { class: 'wicon', html: icon((TYPE_META[w.type] || TYPE_META.chat)[1]) }),
      h('div', { class: 'meta' }, h('b', {}, w.name), h('code', {}, widgetUrl(w))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn sm', title: 'Copy URL', onclick: () => copyText(widgetUrl(w)) }, ic('copy'), 'Copy'),
        h('button', { class: 'btn sm ghost icon', title: 'Customize', 'aria-label': 'Customize', onclick: () => { selectWidget(w.id); location.hash = 'studio'; } }, ic('palette')))))));

  const feed = h('ul', { class: 'feed' }, h('li', {}, h('span', { class: 'muted tiny' }, 'Loading…')));
  ov.feed = feed;
  const activity = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Recent activity'), h('div', { class: 'actions' }, h('a', { class: 'btn sm ghost', href: '#logs' }, 'View all'))), feed);

  const creatorCard = h('div', { class: 'card creator-overview-card', style: 'margin-top:16px' },
    h('div', { class: 'creator-card-main' },
      h('div', { class: 'creator-badge-wolf' }, '🐺'),
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
          h('h3', { style: 'margin:0;font-size:15px' }, 'Created by SmartWolf'),
          h('span', { class: 'tag ok' }, '100% Free Tool · 0% Cut')
        ),
        h('p', { class: 'muted tiny', style: 'margin:3px 0 0' },
          'OmniChat is completely free for all streamers with no ads or subscriptions. If it helps your stream, you can support me with a cup of chai or coffee! ☕')
      ),
      h('button', { class: 'btn primary sm', type: 'button', onclick: showCreatorModal }, ic('coffee'), 'Buy Coffee / Tea')
    ),
    h('div', { class: 'creator-links-row' },
      h('a', { class: 'btn sm ghost', href: 'https://www.youtube.com/@smartwolf_yt', target: '_blank', rel: 'noopener' }, ic('youtube'), 'YouTube @smartwolf_yt'),
      h('a', { class: 'btn sm ghost', href: 'https://www.instagram.com/smartwolf_yt/', target: '_blank', rel: 'noopener' }, ic('instagram'), 'Instagram @smartwolf_yt'),
      h('a', { class: 'btn sm ghost', href: 'https://kick.com/smartwolfyt', target: '_blank', rel: 'noopener' }, ICONS.kick, 'Kick @smartwolfyt'),
      h('a', { class: 'btn sm ghost', href: 'https://discord.gg/smartwolfyt', target: '_blank', rel: 'noopener' }, ic('discord'), 'Discord Wolf Pack')
    )
  );

  root.replaceChildren(hero,
    h('div', { class: 'section-title' }, h('h2', {}, 'Live now')),
    h('div', { class: 'grid kpis' }, ov.yt.card, ov.kk.card, ov.tot.card, ov.msgs.card),
    h('div', { class: 'grid two', style: 'margin-top:16px' }, wl, h('div', { class: 'grid', style: 'align-content:start' }, checklist, activity)),
    creatorCard);
  updateOverview();

  api('/api/logs?limit=6').then((rows) => {
    feed.replaceChildren(...(rows.length ? rows.map(feedItem) : [h('li', {}, h('span', { class: 'muted tiny' }, 'No activity yet.'))]));
  }).catch(() => {});
  api('/api/messages?limit=1').then((r) => {
    msgCounts = Object.fromEntries(r.last24h.map((x) => [x.platform, x.n]));
    updateOverview();
  }).catch(() => {});
}

function feedItem(l) {
  return h('li', {}, h('span', { class: `lv ${l.level}`, html: icon(l.level === 'error' ? 'error' : l.level === 'warn' ? 'alert' : 'info') }),
    h('div', { class: 'txt' }, l.message), h('time', { title: fmtTime(l.ts) }, ago(l.ts)));
}

function updateOverview() {
  if (!ov || page !== 'overview') return;
  const st = liveState || { youtube: {}, kick: {} };
  const fill = (k, d, subsLabel, subs) => {
    if (!d.connected) {
      k.val.textContent = '—';
      k.foot.replaceChildren(h('a', { class: 'tag', href: '#connections' }, 'Not connected'));
      return;
    }
    k.val.textContent = d.live ? fmtN(d.viewers) : 'Offline';
    k.foot.replaceChildren(h('span', { class: `tag ${d.live ? 'live' : d.error ? 'warn' : 'ok'}` }, d.live ? 'LIVE' : d.error ? 'Check' : 'Ready'),
      h('span', {}, `${fmtN(subs)} ${subsLabel}`));
  };
  fill(ov.yt, st.youtube, 'subscribers', st.youtube.subscribers);
  fill(ov.kk, st.kick, st.kick.followers != null ? 'followers' : 'subscribers', st.kick.followers ?? st.kick.subscribers);
  const total = (st.youtube.live ? st.youtube.viewers || 0 : 0) + (st.kick.live ? st.kick.viewers || 0 : 0);
  const anyLive = st.youtube.live || st.kick.live;
  ov.tot.val.textContent = anyLive ? fmtN(total) : '0';
  ov.tot.foot.replaceChildren(h('span', {}, anyLive ? 'Across all live platforms' : 'You are offline'));
  if (me.user.historyDays === 0) {
    ov.msgs.val.textContent = '—';
    ov.msgs.foot.replaceChildren(h('a', { class: 'tag', href: '#settings' }, 'History off'));
  } else if (msgCounts) {
    ov.msgs.val.textContent = fmtN((msgCounts.youtube || 0) + (msgCounts.kick || 0));
    ov.msgs.foot.replaceChildren(h('span', {}, `${fmtN(msgCounts.youtube || 0)} YouTube · ${fmtN(msgCounts.kick || 0)} Kick`));
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Connections
// ═════════════════════════════════════════════════════════════════════
const PLATFORM = {
  youtube: { name: 'YouTube', env: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET' },
  kick: { name: 'Kick', env: 'KICK_CLIENT_ID / KICK_CLIENT_SECRET' },
};

function parseKickPaste(text) {
  const t = String(text || '').trim();
  if (/^\d+$/.test(t)) return { chatroomId: t };
  let j = null;
  try { j = JSON.parse(t); } catch { /* fall back to regex */ }
  const pick = (re) => (t.match(re) || [])[1];
  return {
    chatroomId: j?.chatroom?.id ?? pick(/"chatroom"\s*:\s*\{\s*"id"\s*:\s*(\d+)/),
    channelId: j?.id ?? pick(/^\s*\{\s*"id"\s*:\s*(\d+)/),
    followers: j?.followers_count ?? pick(/"followers_count"\s*:\s*(\d+)/),
  };
}

// ── Kick auto-sync: the streamer's own browser reads their public channel info
//    (Kick blocks this for servers) and hands followers + ids to OmniChat. ──
const kickAuto = { state: 'idle', error: null }; // idle | running | ok | failed
async function autoSyncKick({ force = false } = {}) {
  const acc = me?.accounts.find((a) => a.provider === 'kick');
  if (!acc?.channelSlug || kickAuto.state === 'running') return;
  let last = 0;
  try { last = Number(localStorage.getItem('omnichat.kickSyncAt')) || 0; } catch { /* ignore */ }
  if (!force && acc.followers != null && acc.kickChannelId && Date.now() - last < 10 * 60_000) { kickAuto.state = 'ok'; return; }
  kickAuto.state = 'running';
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(acc.channelSlug)}`, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Kick answered ${r.status}`);
    const j = await r.json();
    const data = { auto: true, chatroomId: j?.chatroom?.id, channelId: j?.id, followers: j?.followers_count };
    if (data.followers == null && !data.channelId) throw new Error('Unexpected response');
    const res = await api('/api/accounts/kick/sync', { method: 'PUT', body: JSON.stringify(data) });
    Object.assign(acc, res.account);
    try { localStorage.setItem('omnichat.kickSyncAt', String(Date.now())); } catch { /* ignore */ }
    kickAuto.state = 'ok';
    kickAuto.error = null;
  } catch (e) {
    kickAuto.state = 'failed';
    kickAuto.error = e.message === 'Failed to fetch' ? 'Kick blocked the request from this browser' : e.message;
  }
  if (page === 'connections') renderConnections();
  if (page === 'overview') renderOverview();
}

function kickSync(acc, st) {
  const needs = kickAuto.state === 'failed' && (st.followers == null || !acc.kickChannelId);
  const input = h('textarea', { class: 'input', rows: 3, placeholder: 'Paste the whole page here…', 'aria-label': 'Kick channel data' });
  const go = h('button', { class: 'btn primary sm', type: 'button' }, ic('refresh'), 'Sync from Kick');
  go.addEventListener('click', async () => {
    const data = parseKickPaste(input.value);
    if (!data.chatroomId && !data.channelId && !data.followers) return toast('Could not find Kick data in what you pasted', 'err');
    try {
      const r = await api('/api/accounts/kick/sync', { method: 'PUT', body: JSON.stringify(data) });
      Object.assign(acc, r.account);
      input.value = '';
      toast(data.followers ? `Synced · ${fmtN(Number(data.followers))} followers` : 'Synced');
    } catch (e) { toast(e.message, 'err'); }
  });
  const link = `https://kick.com/api/v2/channels/${encodeURIComponent(acc.channelSlug || '')}`;
  return h('details', { class: 'disclose', open: needs ? true : undefined },
    h('summary', {}, ic('refresh'), 'Manual sync (only if automatic sync fails)'),
    h('div', { class: 'inner' },
      h('ol', { class: 'steps' },
        h('li', {}, 'Open ', h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'your Kick channel data'), ' in a new tab'),
        h('li', {}, 'Press ⌘/Ctrl + A, then ⌘/Ctrl + C'),
        h('li', {}, 'Paste it below and press Sync')),
      input, h('div', {}, go)));
}

function renderConnections() {
  const root = $('#page-connections');
  const cards = ['youtube', 'kick'].map((p) => {
    const info = PLATFORM[p];
    const acc = me.accounts.find((a) => a.provider === p);
    const st = liveState?.[p] || {};
    const body = h('div', { class: 'conn-body' });
    body.append(h('div', { class: 'conn-head' },
      h('div', { class: 'conn-logo', html: ICONS[p] }),
      h('div', {}, h('b', {}, info.name), h('span', { class: 'muted tiny' }, acc ? 'Connected · read-only access' : 'Not connected')),
      acc ? h('span', { class: `tag ${st.live ? 'live' : 'ok'}`, style: 'margin-left:auto' }, st.live ? '● LIVE' : 'Connected') : null));

    if (acc) {
      body.append(h('div', { class: 'acct' },
        acc.avatar ? h('img', { src: acc.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }),
        h('div', { class: 'meta' }, h('b', {}, acc.channelName || '—'), h('span', { class: 'muted tiny' }, p === 'kick' ? `kick.com/${acc.channelSlug}` : acc.channelSlug || acc.channelId))));
      const kickSubs = p === 'kick' && st.followers == null;
      body.append(h('div', { class: 'stat3' },
        h('div', {}, h('span', {}, 'Status'), h('b', {}, st.live ? 'Live' : 'Offline')),
        h('div', {}, h('span', {}, 'Viewers'), h('b', {}, st.live ? fmtN(st.viewers) : '—')),
        h('div', {}, h('span', {}, p === 'youtube' || kickSubs ? 'Subscribers' : 'Followers'), h('b', {}, fmtN(p === 'youtube' || kickSubs ? st.subscribers : st.followers)))));
      if (p === 'youtube' && st.subscribersMode === 'exact') {
        body.append(h('div', { class: 'notice ok' }, ic('users'), h('div', {},
          `Exact subscriber count from YouTube Analytics (no estimate). YouTube adds new subscribers there 2–3 days late.`)));
      } else if (p === 'youtube' && st.connected && st.subscribers != null && st.subscribersConfirmed != null) {
        body.append(h('div', { class: 'notice info' }, ic('info'), h('div', {},
          `Showing YouTube’s official count (rounded). The exact Analytics number (${fmtN(st.subscribersConfirmed)}) is a few days behind, so it isn’t shown.`)));
      } else if (p === 'youtube' && st.connected && st.subscribers != null) {
        body.append(h('div', { class: 'notice info' }, ic('info'), h('div', {},
          'Showing YouTube’s rounded subscriber count. ', h('a', { href: '/auth/youtube' }, 'Reconnect YouTube'), ' once to show the exact number.')));
      }
      if (p === 'kick') {
        if (st.chatMode === 'webhook') body.append(h('div', { class: 'notice ok' }, ic('check'), h('div', {}, 'Chat is automatic through official Kick webhooks.')));
        else if (st.chatMode === 'pusher' && st.chatConnected) body.append(h('div', { class: 'notice ok' }, ic('check'), h('div', {}, 'Chat connected.')));
        else body.append(h('div', { class: 'notice info' }, ic('info'), h('div', {}, acc.chatroomId ? 'Connecting chat…' : 'Chat connects automatically once your channel details sync from Kick.')));
        if (kickAuto.state === 'running') body.append(h('div', { class: 'notice info' }, ic('refresh'), h('div', {}, 'Syncing followers from Kick…')));
        else if (st.followers != null) body.append(h('div', { class: 'notice ok' }, ic('users'), h('div', {}, `${fmtN(st.followers)} followers · synced automatically${acc.kickChannelId ? ' · updates live' : ''}`)));
        else if (kickAuto.state === 'failed') body.append(h('div', { class: 'notice warn' }, ic('alert'), h('div', {}, `Automatic follower sync didn't work (${kickAuto.error}). Use manual sync below once.`)));
        body.append(h('div', {}, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => autoSyncKick({ force: true }) }, ic('refresh'), 'Refresh followers')));
        if (kickAuto.state === 'failed') body.append(kickSync(acc, st));
      }
      if (st.error) body.append(h('div', { class: 'notice warn' }, ic('alert'), h('div', {}, st.error)));
      body.append(h('div', { class: 'conn-actions' },
        h('a', { class: 'btn sm', href: `/auth/${p}` }, ic('refresh'), 'Reconnect'),
        st.url ? h('a', { class: 'btn sm ghost', href: st.url, target: '_blank', rel: 'noopener noreferrer' }, ic('external'), 'Channel') : null,
        h('button', { class: 'btn sm ghost danger', style: 'margin-left:auto', onclick: () => disconnect(p) }, 'Disconnect')));
    } else if (me.providers[p]) {
      body.append(h('p', { class: 'muted', style: 'margin:0' }, `Connect ${info.name} to bring its chat and stats into your widgets. OmniChat only asks for read-only access.`));
      body.append(h('div', { class: 'conn-actions' }, h('a', { class: `btn ${p === 'youtube' ? 'yt' : 'kick'}`, href: `/auth/${p}` }, h('span', { html: ICONS[p], style: 'display:inline-flex;width:18px;height:18px' }), `Connect ${info.name}`)));
    } else {
      body.append(h('div', { class: 'notice warn' }, ic('alert'), h('div', {}, `${info.name} login isn't configured on this server. The admin must set ${info.env}.`)));
    }
    return h('div', { class: `card conn ${p}` }, h('div', { class: 'conn-band' }), body);
  });

  const how = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Add your overlay to OBS'), h('div', { class: 'actions' },
      h('button', { class: 'btn sm ghost', onclick: restartWatchers }, ic('refresh'), 'Restart watchers'))),
    h('div', { class: 'card-pad' }, h('ol', { class: 'howto' },
      h('li', {}, h('b', {}, 'Copy URL'), 'Studio → pick a widget → Copy URL.'),
      h('li', {}, h('b', {}, 'Add source'), 'OBS → Sources → + → Browser, paste the URL.'),
      h('li', {}, h('b', {}, 'Size it'), 'Chat 400 × 700 · Stats 800 × 140. Background stays transparent.'),
      h('li', {}, h('b', {}, 'Go live'), 'Chat and numbers appear within seconds of going live.'))));

  root.replaceChildren(h('div', { class: 'grid cols-2' }, cards), h('div', { style: 'height:16px' }), how);
}

async function disconnect(p) {
  if (!(await dialog({ title: `Disconnect ${PLATFORM[p].name}?`, text: 'OmniChat revokes its access token and stops reading this channel. You can reconnect any time.', confirm: 'Disconnect', danger: true }))) return;
  try {
    await api(`/api/accounts/${p}`, { method: 'DELETE' });
    me.accounts = me.accounts.filter((a) => a.provider !== p);
    renderConnections();
    renderUser();
    toast('Disconnected');
  } catch (e) { toast(e.message, 'err'); }
}
async function restartWatchers() {
  try { await api('/api/watchers/restart', { method: 'POST' }); toast('Watchers restarted'); } catch (e) { toast(e.message, 'err'); }
}

// ═════════════════════════════════════════════════════════════════════
//  Logs
// ═════════════════════════════════════════════════════════════════════
const logsUi = { tab: 'system', level: '', q: '', platform: '', paused: false, rows: [], chat: [] };

function lvlBadge(l) {
  return h('span', { class: `lvl ${l}`, html: icon(l === 'error' ? 'error' : l === 'warn' ? 'alert' : 'info') }, l);
}
function srcCell(s) {
  const ico = s === 'youtube' || s === 'kick' ? ICONS[s] : icon(s === 'auth' ? 'key' : s === 'system' ? 'settings' : 'info');
  return h('span', { class: 'src' }, h('span', { html: ico, style: 'display:inline-flex;width:15px;height:15px' }), s);
}
function whenCell(ts) {
  return h('td', { class: 'when', title: fmtTime(ts), 'data-ts': ts }, h('b', {}, ago(ts)), new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
}

function renderLogs() {
  const root = $('#page-logs');
  const tabs = h('div', { class: 'seg' },
    h('button', { class: logsUi.tab === 'system' ? 'on' : '', onclick: () => { logsUi.tab = 'system'; logsUi.q = ''; renderLogs(); } }, ic('logs'), 'System'),
    h('button', { class: logsUi.tab === 'chat' ? 'on' : '', onclick: () => { logsUi.tab = 'chat'; logsUi.q = ''; renderLogs(); } }, ic('message'), 'Chat history'));
  const search = h('div', { class: 'input-icon search' }, ic('search'),
    h('input', { class: 'input', type: 'search', placeholder: logsUi.tab === 'system' ? 'Search logs…' : 'Search user or message…', value: logsUi.q, maxlength: 100, 'aria-label': 'Search' }));
  let qt;
  $('input', search).addEventListener('input', (e) => { logsUi.q = e.target.value; clearTimeout(qt); qt = setTimeout(loadLogs, 250); });

  const bar = h('div', { class: 'logbar' }, tabs, search);
  if (logsUi.tab === 'system') {
    bar.append(h('div', { class: 'seg', id: 'lvl-seg' }), h('div', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost live-toggle', title: logsUi.paused ? 'Resume live updates' : 'Pause live updates', onclick: () => { logsUi.paused = !logsUi.paused; renderLogs(); } },
        h('span', { class: 'live-ind' + (logsUi.paused ? ' paused' : '') }), logsUi.paused ? 'Paused' : 'Live'),
      h('button', { class: 'btn sm', onclick: () => exportCsv('omnichat-logs', ['time', 'level', 'source', 'message'], logsUi.rows.map((r) => [new Date(r.ts).toISOString(), r.level, r.source, r.message])) }, ic('download'), 'Export CSV'),
      h('button', { class: 'btn sm ghost danger', onclick: clearLogs }, ic('trash'), 'Clear'));
  } else {
    const pf = h('select', { class: 'select', style: 'width:auto', 'aria-label': 'Platform' },
      h('option', { value: '' }, 'All platforms'), h('option', { value: 'youtube' }, 'YouTube'), h('option', { value: 'kick' }, 'Kick'));
    pf.value = logsUi.platform;
    pf.addEventListener('change', () => { logsUi.platform = pf.value; loadLogs(); });
    bar.append(pf, h('div', { class: 'spacer' }), h('span', { class: 'tiny muted', id: 'chat-count' }),
      h('button', { class: 'btn sm', onclick: () => exportCsv('omnichat-chat', ['time', 'platform', 'type', 'user', 'message'], logsUi.chat.map((m) => [new Date(m.ts).toISOString(), m.platform, m.kind, m.author, m.text || ''])) }, ic('download'), 'Export CSV'));
  }
  root.replaceChildren(h('div', { class: 'card' }, bar,
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead'), h('tbody'))),
    h('div', { class: 'empty', id: 'logs-empty', hidden: true })));
  loadLogs();
}

function setEmpty(show, title, text) {
  const e = $('#logs-empty');
  if (!e) return;
  e.hidden = !show;
  if (show) e.replaceChildren(ic('logs'), h('b', {}, title), text);
}

async function loadLogs() {
  if (page !== 'logs') return;
  const thead = $('#page-logs thead');
  const tbody = $('#page-logs tbody');
  if (!tbody) return;
  try {
    if (logsUi.tab === 'system') {
      const rows = await api(`/api/logs?limit=500&q=${encodeURIComponent(logsUi.q)}`);
      logsUi.rows = rows;
      const counts = { '': rows.length, info: 0, warn: 0, error: 0 };
      for (const r of rows) counts[r.level] = (counts[r.level] || 0) + 1;
      $('#lvl-seg')?.replaceChildren(...[['', 'All'], ['info', 'Info'], ['warn', 'Warnings'], ['error', 'Errors']].map(([v, label]) =>
        h('button', { class: logsUi.level === v ? 'on' : '', onclick: () => { logsUi.level = v; loadLogs(); } }, label, h('span', { class: 'n' }, String(counts[v] || 0)))));
      const shown = rows.filter((r) => !logsUi.level || r.level === logsUi.level);
      thead.replaceChildren(h('tr', {}, ['When', 'Level', 'Source', 'Message'].map((x) => h('th', {}, x))));
      tbody.replaceChildren(...shown.map((l) => logRow(l)));
      setEmpty(!shown.length, 'No logs here', 'Connection events, live status changes and errors show up here.');
    } else {
      const r = await api(`/api/messages?limit=500&q=${encodeURIComponent(logsUi.q)}${logsUi.platform ? '&platform=' + logsUi.platform : ''}`);
      logsUi.chat = r.rows;
      thead.replaceChildren(h('tr', {}, ['When', 'Platform', 'User', 'Message'].map((x) => h('th', {}, x))));
      tbody.replaceChildren(...r.rows.map((m) => h('tr', { class: m.deleted ? 'del' : '' },
        whenCell(m.ts),
        h('td', {}, srcCell(m.platform)),
        h('td', { class: 'who' }, m.author),
        h('td', { class: 'msgc' }, m.kind !== 'chat' ? h('span', { class: 'kind' }, m.kind) : null, m.text || ''))));
      const c = Object.fromEntries(r.last24h.map((x) => [x.platform, x.n]));
      $('#chat-count').textContent = `Last 24h: ${fmtN(c.youtube || 0)} YouTube · ${fmtN(c.kick || 0)} Kick`;
      const off = me.user.historyDays === 0;
      setEmpty(!r.rows.length, off ? 'Chat history is turned off' : 'No messages yet', off ? 'Turn it on in Settings → Privacy & data.' : 'Messages from your live streams are saved here.');
    }
  } catch (e) { toast(e.message, 'err'); }
}

function logRow(l, isNew = false) {
  return h('tr', { class: isNew ? 'new' : '' }, whenCell(l.ts), h('td', {}, lvlBadge(l.level)), h('td', {}, srcCell(l.source)), h('td', { class: 'msgc' }, l.message));
}

function onLiveLog(l) {
  if (ov?.feed && page === 'overview') { ov.feed.prepend(feedItem(l)); while (ov.feed.children.length > 6) ov.feed.lastElementChild.remove(); }
  if (page !== 'logs' || logsUi.tab !== 'system' || logsUi.paused) return;
  logsUi.rows.unshift(l);
  if (logsUi.level && l.level !== logsUi.level) return;
  if (logsUi.q && !`${l.message} ${l.source}`.toLowerCase().includes(logsUi.q.toLowerCase())) return;
  $('#page-logs tbody')?.prepend(logRow(l, true));
  setEmpty(false);
}

async function clearLogs() {
  if (!(await dialog({ title: 'Clear all logs?', text: 'This permanently deletes your system logs.', confirm: 'Clear logs', danger: true }))) return;
  await api('/api/logs', { method: 'DELETE' });
  toast('Logs cleared');
  loadLogs();
}

/** CSV export with formula-injection protection (cells starting with = + - @ are neutralised). */
function exportCsv(name, head, rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: `${name}-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ═════════════════════════════════════════════════════════════════════
//  Settings
// ═════════════════════════════════════════════════════════════════════
function renderSettings() {
  const root = $('#page-settings');
  const theme = h('div', { class: 'theme-switch', style: 'width:300px;max-width:100%' });
  bindThemeSwitch(theme);
  bindThemeSwitch($('#theme-switch')); // keep sidebar switch in sync

  const retention = h('select', { class: 'select', style: 'width:180px', 'aria-label': 'Chat history retention' },
    [[0, "Don't save"], [1, '1 day'], [7, '7 days'], [30, '30 days']].map(([v, l]) => {
      const o = h('option', { value: v }, l);
      if (Number(v) === Number(me.user.historyDays)) o.selected = true;
      return o;
    }));
  retention.addEventListener('change', async () => {
    const days = Number(retention.value);
    if (days < me.user.historyDays && !(await dialog({ title: 'Shorten chat history?', text: days ? `Messages older than ${days} day(s) will be deleted now.` : 'All saved chat messages will be deleted now and new ones will not be saved.', confirm: 'Apply', danger: true }))) {
      retention.value = me.user.historyDays;
      return;
    }
    try {
      await api('/api/me/settings', { method: 'PUT', body: JSON.stringify({ historyDays: days }) });
      me.user.historyDays = days;
      toast('Privacy setting saved');
    } catch (e) { toast(e.message, 'err'); retention.value = me.user.historyDays; }
  });

  const row = (title, sub, ctl) => h('div', { class: 'srow' }, h('div', { class: 'txt' }, h('b', {}, title), h('span', {}, sub)), ctl);

  root.replaceChildren(h('div', { class: 'settings' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('palette'), h('h3', {}, 'Appearance')),
      row('Theme', 'Follow your system, or always use light or dark.', theme)),

    h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('database'), h('h3', {}, 'Privacy & data')),
      row('Chat history', 'How long chat messages are kept for search and export. Older ones are deleted automatically.', retention),
      row('Clear chat history', 'Delete every saved chat message now.', h('button', { class: 'btn danger', onclick: clearChat }, ic('trash'), 'Clear history')),
      row('System logs', 'Kept for 14 days, then deleted automatically.', h('a', { class: 'btn', href: '#logs' }, 'View logs'))),

    h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('shield'), h('h3', {}, 'Security')),
      row('Active sessions', `You're signed in on ${me.user.sessions} device${me.user.sessions === 1 ? '' : 's'}. Sessions expire after 30 days.`,
        h('button', { class: 'btn', onclick: logoutAll }, ic('logout'), 'Sign out everywhere')),
      h('ul', { class: 'shield-list' },
        ['Read-only access to YouTube and Kick — OmniChat never posts, moderates or reads stream keys.',
          'OAuth tokens are encrypted (AES-256-GCM) in the database; your passwords are never seen or stored.',
          'Secure, HttpOnly session cookies; sign-in is protected against CSRF and replay.',
          'Widget URLs are random and can be regenerated any time from Studio.',
          'Disconnecting a platform or deleting your account revokes tokens with the provider immediately.'].map((t) => h('li', {}, ic('check'), h('span', {}, t))))),

    h('div', { class: 'card danger' }, h('div', { class: 'card-head' }, ic('alert'), h('h3', {}, 'Danger zone')),
      row('Delete account', 'Permanently deletes your account, connections, widgets, logs and chat history, and revokes all tokens. This cannot be undone.',
        h('button', { class: 'btn danger solid', onclick: deleteAccount }, ic('trash'), 'Delete account')))));
}

async function clearChat() {
  if (!(await dialog({ title: 'Clear chat history?', text: 'All saved chat messages will be permanently deleted.', confirm: 'Clear history', danger: true }))) return;
  try { await api('/api/messages', { method: 'DELETE' }); toast('Chat history cleared'); } catch (e) { toast(e.message, 'err'); }
}
async function logoutAll() {
  if (!(await dialog({ title: 'Sign out everywhere?', text: 'Every browser and device signed in to this account will be signed out, including this one.', confirm: 'Sign out everywhere', danger: true }))) return;
  await fetch('/auth/logout-all', { method: 'POST', credentials: 'same-origin' });
  location.replace('/login');
}
async function deleteAccount() {
  const ok = await dialog({ title: 'Delete your OmniChat account?', text: 'Everything is erased and your YouTube/Kick access is revoked. Your widget URLs stop working.', confirm: 'Delete forever', danger: true, requireText: 'DELETE' });
  if (!ok) return;
  try {
    await api('/api/me', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
    location.replace('/login?error=' + encodeURIComponent('Your account and all its data were deleted.'));
  } catch (e) { toast(e.message, 'err'); }
}

// ═════════════════════════════════════════════════════════════════════
//  Egg Bot
// ═════════════════════════════════════════════════════════════════════
const RARITY_COLORS = { common: '#9ca3af', uncommon: '#22c55e', rare: '#3b82f6', epic: '#a855f7', legendary: '#f59e0b', mythic: '#ef4444', secret: '#8b5cf6', eternal: '#06b6d4', divine: '#eab308' };
const rarityTag = (r) => h('span', { class: 'tag', style: `background:${(RARITY_COLORS[(r || '').toLowerCase()] || '#6b7280')}22;color:${RARITY_COLORS[(r || '').toLowerCase()] || 'var(--muted)'}` }, r || 'Egg');

async function renderEggs() {
  const root = $('#page-eggs');
  let data;
  try { data = await api('/api/eggs'); } catch (e) { toast(e.message, 'err'); return; }
  if (page !== 'eggs') return;
  const { settings: s, items, status: st } = data;
  const events = data.events || [];
  const save = async (patch, msg = 'Saved') => {
    try { await api('/api/eggs/settings', { method: 'PUT', body: JSON.stringify(patch) }); toast(msg); } catch (e) { toast(e.message, 'err'); }
    renderEggs();
  };
  const toggle = (checked, onChange) => {
    const i = h('input', { type: 'checkbox' });
    i.checked = checked;
    i.addEventListener('change', () => onChange(i.checked));
    return h('span', { class: 'switch' }, i, h('span'));
  };
  const row = (title, sub, ctl) => h('label', { class: 'srow', style: 'cursor:pointer' }, h('div', { class: 'txt' }, h('b', {}, title), h('span', {}, sub)), ctl);

  // ── status (read-only for streamers) ──
  const yc = st.youtubeConnected;
  const kc = st.kickConnected;
  const liveParts = [yc ? `YouTube: ${st.ytLive ? 'LIVE' : 'offline'}` : null, kc ? `Kick: ${st.kickLive ? 'LIVE' : 'offline'}` : null].filter(Boolean).join(' · ');
  const steps = [
    [st.feedReady, 'Egg feed', st.feedReady ? `Receiving Steal an Egg spawns · checked ${ago(st.lastCheckAt)}` : st.feedError ? `Paused: ${st.feedError}` : 'Starting… (the OmniChat team sets this up)'],
    yc ? [st.youtubeBotReady, 'YouTube · OmniChat Bot', st.youtubeBotReady ? `Messages are posted as ${st.youtubeBot.channelName}` : 'The OmniChat Bot is being set up — nothing to do on your side'] : null,
    kc ? [st.kickChatReady, 'Kick · bot', st.kickChatReady ? 'Your Kick chat is ready for bot messages' : 'Reconnect Kick once so the bot can post',
      !st.kickChatReady ? h('a', { class: 'btn sm primary', href: '/auth/kick' }, 'Reconnect Kick') : null] : null,
    [st.ytLive || st.kickLive, 'Live status', `${liveParts} — the bot posts only where you are live`],
  ].filter(Boolean);
  const checklist = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, ic('check'), h('h3', {}, 'Status')),
    h('ul', { class: 'checklist' }, steps.map(([ok, title, sub, action]) =>
      h('li', { class: ok ? 'done' : '' }, h('span', { class: 'check', html: icon('check') }), h('div', { class: 'txt' }, h('b', {}, title), h('span', {}, sub)), action))));

  // ── the streamer's switches ──
  const known = [...new Set([...(data.rarities || []), ...s.rarities])];
  const chips = h('div', { class: 'quick' },
    h('button', { type: 'button', class: 'btn sm' + (!s.rarities.length ? ' primary' : ''), onclick: () => save({ rarities: [] }) }, 'All eggs'),
    known.map((r) => h('button', {
      type: 'button', class: 'btn sm' + (s.rarities.includes(r) ? ' primary' : ''),
      onclick: () => save({ rarities: s.rarities.includes(r) ? s.rarities.filter((x) => x !== r) : [...s.rarities, r] }),
    }, r)));
  const latest = items[0];
  const preview = latest ? `🥚 ${latest.rarity ? latest.rarity + ' Egg' : 'Egg'} spawned: ${latest.name}${latest.location ? ' | 📍' + latest.location : ''}${latest.money ? ' | 💰' + latest.money : ''}${latest.speed ? ' | ⚡' + latest.speed : ''}` : '🥚 Secret Egg spawned: Stormclaw Wolf | 📍Stormlands | 💰~$36m/s | ⚡150M';

  const settingsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, ic('egg'), h('h3', {}, 'Egg Bot'), h('div', { class: 'actions' }, h('span', { class: 'tag ' + (s.enabled ? 'ok' : '') }, s.enabled ? 'ON' : 'OFF'))),
    row('Egg Bot', 'ON = the OmniChat Bot posts every new Steal an Egg spawn in your chat. OFF = it stays quiet.', toggle(s.enabled, (v) => save({ enabled: v }, v ? 'Egg Bot ON' : 'Egg Bot OFF'))),
    // Only platforms you have connected get a switch.
    yc ? row('YouTube chat', st.youtubeBot ? `Posted by ${st.youtubeBot.channelName}` : 'Posted by the OmniChat Bot', toggle(s.youtube, (v) => save({ youtube: v }, v ? 'YouTube ON' : 'YouTube OFF'))) : null,
    kc ? row('Kick chat', 'Posted by the OmniChat Kick bot', toggle(s.kick, (v) => save({ kick: v }, v ? 'Kick ON' : 'Kick OFF'))) : null,
    !yc || !kc ? h('div', { class: 'srow' }, h('div', { class: 'txt' },
      h('b', {}, `Add ${!yc ? 'YouTube' : 'Kick'}`),
      h('span', {}, `Connect ${!yc ? 'YouTube' : 'Kick'} to use the Egg Bot there too.`)),
      h('a', { class: 'btn sm', href: '#connections' }, 'Connect')) : null,
    row('Game events', 'Also post events like 🌊 Tidal Surge, 🦋 Butterfly Bloom and 🕶️ Slick Rick when they happen.', toggle(s.events !== false, (v) => save({ events: v }, v ? 'Events ON' : 'Events OFF'))),
    row('!egghistory command', 'Viewers type !egghistory to see the last 10 eggs · 30 s cooldown.', toggle(s.commandEnabled, (v) => save({ commandEnabled: v }))),
    h('div', { class: 'srow', style: 'flex-direction:column;align-items:stretch;gap:8px' },
      h('div', { class: 'txt' }, h('b', {}, 'Which eggs to post'), h('span', {}, 'Pick rarities to announce, or all eggs.')), chips),
    h('div', { class: 'srow', style: 'flex-direction:column;align-items:stretch;gap:8px' },
      h('div', { class: 'txt' }, h('b', {}, 'Message preview'), h('span', {}, `YouTube messages today: ${st.postedToday}/${st.dailyLimit}`)),
      h('code', { class: 'egg-preview' }, preview),
      h('div', {}, h('button', { class: 'btn sm', type: 'button', onclick: async () => {
        try {
          const r = await api('/api/eggs/test', { method: 'POST' });
          toast(`YouTube: ${r.result.youtube} · Kick: ${r.result.kick}`, r.result.youtube === 'sent' || r.result.kick === 'sent' ? 'ok' : 'err');
        } catch (e) { toast(e.message, 'err'); }
      } }, ic('send'), 'Send test message'))),
    h('div', { class: 'srow' }, h('div', { class: 'txt' }, h('b', {}, ic('bulb'), ' Tip'), h('span', {}, 'Make the OmniChat Bot a moderator on your YouTube channel so slow mode never blocks it.'))));

  // ── OmniChat Bot account only: the shared setup ──
  let botCard = null;
  if (st.isBot) {
    const chInput = h('input', { class: 'input', value: st.channelId || '', placeholder: 'e.g. 1569620117942173728', inputmode: 'numeric', 'aria-label': 'Discord channel ID' });
    botCard = h('div', { class: 'card admin-card' },
      h('div', { class: 'card-head' }, ic('shield'), h('h3', {}, 'OmniChat Bot setup'), h('span', { class: 'sub' }, 'Only visible to the bot account')),
      h('div', { class: 'srow' }, h('div', { class: 'txt' }, h('b', {}, 'YouTube posting'),
        h('span', {}, st.youtubeBotReady ? `Active as ${st.youtubeBot.channelName}. It refreshes every time this account signs in.` : 'Not active yet — click Reconnect.')),
        h('a', { class: 'btn sm primary', href: '/auth/youtube?sharedbot=1' }, 'Reconnect')),
      h('div', { class: 'srow', style: 'flex-direction:column;align-items:stretch;gap:8px' },
        h('div', { class: 'txt' }, h('b', {}, 'Discord egg channel'), h('span', {}, st.discordConfigured ? 'Every streamer’s Egg Bot reads this channel.' : 'DISCORD_BOT_TOKEN is missing on the server.')),
        h('div', { class: 'wpick' }, chInput, h('button', { class: 'btn', type: 'button', onclick: async () => {
          try { await api('/api/eggs/channel', { method: 'PUT', body: JSON.stringify({ channelId: chInput.value.trim() }) }); toast('Egg channel saved'); } catch (e) { toast(e.message, 'err'); }
          renderEggs();
        } }, 'Save'))));
  }

  // ── recent eggs (shared feed) ──
  const history = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, ic('clock'), h('h3', {}, 'Recent eggs'), h('span', { class: 'sub' }, `${items.length} saved · updates every 10 s`)),
    items.length
      ? h('div', { class: 'table-wrap', style: 'max-height:560px' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['When', 'Egg', 'Details'].map((x) => h('th', {}, x)))),
        h('tbody', {}, items.map((e) => h('tr', {},
          h('td', { class: 'when', title: fmtTime(e.ts) }, h('b', {}, ago(e.ts)), new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
          h('td', {}, h('b', { class: 'who', style: 'display:block' }, e.name), rarityTag(e.rarity)),
          h('td', { class: 'egg-details' }, e.location ? h('span', {}, `📍 ${e.location}`) : null, e.money ? h('span', {}, `💰 ${e.money}`) : null, e.speed ? h('span', {}, `⚡ ${e.speed}`) : null))))))
      : h('div', { class: 'empty' }, ic('egg'), h('b', {}, 'No eggs yet'), 'Turn the Egg Bot ON — new spawns show up here within seconds.'));

  // ── recent game events (same Discord feed) ──
  const evCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, ic('zap'), h('h3', {}, 'Recent events'), h('span', { class: 'sub' }, 'Tidal Surge, Butterfly Bloom, Slick Rick …')),
    events.length
      ? h('div', { class: 'table-wrap', style: 'max-height:360px' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['When', 'Event', 'Where'].map((x) => h('th', {}, x)))),
        h('tbody', {}, events.map((ev) => h('tr', {},
          h('td', { class: 'when', title: fmtTime(ev.ts) }, h('b', {}, ago(ev.ts)), new Date(ev.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
          h('td', {}, h('b', { class: 'who', style: 'display:block' }, `${ev.emoji || '✨'} ${ev.name}`),
            ev.endsAt && ev.endsAt > Date.now() ? h('span', { class: 'tag ok' }, 'ACTIVE') : null),
          h('td', { class: 'egg-details' }, ev.where ? h('span', {}, `📍 ${ev.where}`) : null, ev.section ? h('span', {}, `${ev.section.title}: ${ev.section.lines.slice(0, 3).join(' · ')}`) : null))))))
      : h('div', { class: 'empty' }, ic('zap'), h('b', {}, 'No events yet'), 'New events from the Discord channel show up here.'));

  root.replaceChildren(h('div', { class: 'grid two' },
    h('div', { class: 'grid', style: 'align-content:start' }, botCard, settingsCard),
    h('div', { class: 'grid', style: 'align-content:start' }, checklist, evCard, history)));
}
setInterval(() => { if (page === 'eggs' && !document.activeElement?.closest('#page-eggs input')) renderEggs(); }, 10_000);

// ═════════════════════════════════════════════════════════════════════
//  What's New Modal
// ═════════════════════════════════════════════════════════════════════
const WHATS_NEW_ITEMS = [
  {
    badge: 'COMMUNITY',
    color: 'warn',
    icon: 'coffee',
    title: 'Support the Creator (SmartWolf 🐺)',
    desc: 'OmniChat is 100% free with no ads, no subscriptions, and 0% platform cuts. If OmniChat empowers your stream, you can support the developer (SmartWolf) with a cup of chai or coffee via UPI!'
  },
  {
    badge: 'NEW',
    color: 'ok',
    icon: 'heart',
    title: 'Customizable Donate Overlay & Animated Loader',
    desc: 'OBS Donate overlay now features a smooth animated loading spinner so widgets never flash or delay on stream. Fully customizable layout: Scanner-only mode (hide text & links), stacked vertical cards, position UPI ID directly underneath the QR scanner or beside it, and customize QR scanner size.'
  },
  {
    badge: 'NEW',
    color: 'ok',
    icon: 'heart',
    title: 'Real-time UPI Donations (0% Platform Fee)',
    desc: 'Direct-to-streamer UPI payments via QR code & mobile deep-link (GPay, PhonePe, Paytm, BHIM) with zero platform fees. Features real-time approval popup with audio chime, live in-place notes list without refreshing, and "Send another donation" support.'
  },
  {
    badge: 'NEW',
    color: 'purple',
    icon: 'bell',
    title: 'Dedicated Alerts Overlay Widget',
    desc: 'Standalone OBS overlay for Super Chats, Memberships, Gifts, Kick subs/follows, "said hi" greetings, and UPI donations. Features 18 procedural WebAudio synthesizer sounds, custom picture/audio uploads, 7 visual styles, and stream count badges.'
  },
  {
    badge: 'NEW',
    color: 'warn',
    icon: 'zap',
    title: 'Live Tools & Chatbot Automation',
    desc: 'All-in-one broadcast utility: 1-click Highlight Chat message on stream, interactive live polls (!vote 1) with animated OBS bar overlay, custom chatbot !commands with variables, automated live timers, and post-stream analytics summary.'
  },
  {
    badge: 'NEW',
    color: 'blue',
    icon: 'target',
    title: 'Subscriber & Follower Goal Bar',
    desc: 'Live animated goal progress bar overlay for YouTube subscribers, Kick followers, or combined totals with custom targets and percentage display.'
  },
  {
    badge: 'EXPANDED',
    color: 'purple',
    icon: 'palette',
    title: '7 Overlays in Studio Suite',
    desc: 'Studio now includes Chat, Stats, Alerts, Eggs Tracker, Goal Bar, Live Poll, and Donate QR widgets with instant OBS copy links and real-time previews.'
  },
  {
    badge: 'UPDATED',
    color: 'ok',
    icon: 'egg',
    title: 'Egg Bot Game Events & Multi-Layouts',
    desc: 'Automatic detection and announcements for game events (Tidal Surge, Butterfly Bloom, Slick Rick). New Alert, Spotlight, and Events layouts with Fit to screen auto-scaling for horizontal 16:9 and vertical 9:16 Shorts.'
  }
];

let whatsNewOpen = false;
function showWhatsNewModal() {
  if (whatsNewOpen) return;
  whatsNewOpen = true;
  let bg;
  const close = () => {
    whatsNewOpen = false;
    if (bg) bg.remove();
    document.removeEventListener('keydown', onKey);
    if (location.hash === '#whats-new') history.replaceState(null, '', '#' + (prevPage || 'overview'));
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const list = h('div', { class: 'wn-list' }, WHATS_NEW_ITEMS.map((item) => h('div', { class: 'wn-card' },
    h('div', { class: 'wn-head' },
      h('div', { class: 'wn-icon' }, ic(item.icon)),
      h('div', { class: 'wn-meta' },
        h('div', { class: 'wn-row' },
          h('b', { class: 'wn-title' }, item.title),
          h('span', { class: `tag ${item.color}` }, item.badge)
        ),
        h('p', { class: 'wn-desc' }, item.desc)
      )
    )
  )));

  bg = h('div', { class: 'modal-bg', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === bg) close(); } },
    h('div', { class: 'modal wn-modal' },
      h('div', { class: 'wn-modal-head' },
        h('div', { style: 'display:flex;align-items:center;gap:12px' },
          h('span', { class: 'wn-title-icon' }, ic('sparkles')),
          h('div', {}, h('h3', { style: 'margin:0;font-size:18px' }, "What's new in OmniChat"), h('p', { class: 'muted tiny', style: 'margin:2px 0 0' }, 'Latest updates & features (November 2026)'))
        ),
        h('button', { type: 'button', class: 'btn sm ghost icon', title: 'Close', onclick: close }, '✕')
      ),
      list,
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' },
        h('button', { type: 'button', class: 'btn primary', onclick: close }, "Awesome, let's explore!")
      )
    )
  );

  document.body.append(bg);
}

let creatorModalOpen = false;
function showCreatorModal() {
  if (creatorModalOpen) return;
  creatorModalOpen = true;
  let bg;
  const close = () => {
    creatorModalOpen = false;
    if (bg) bg.remove();
    document.removeEventListener('keydown', onKey);
    if (location.hash === '#creator') history.replaceState(null, '', '#' + (prevPage || 'overview'));
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  let currentAmount = 50;
  const upiId = 'smartwolfyt@upi';
  const payeeName = 'SmartWolf';

  const makeUpiUrl = (amt) =>
    `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${amt}&cu=INR&tn=${encodeURIComponent('OmniChat Chai Coffee')}`;

  const qrImg = h('img', {
    class: 'creator-qr-img',
    src: `/api/qr.svg?d=${encodeURIComponent(makeUpiUrl(currentAmount))}`,
    alt: 'UPI QR code to support SmartWolf'
  });

  const payLink = h('a', {
    class: 'btn primary creator-pay-btn',
    href: makeUpiUrl(currentAmount),
    target: '_blank',
    rel: 'noopener'
  }, ic('rupee'), `Pay ₹${currentAmount} via UPI App`);

  const amounts = [
    { amt: 20, label: '₹20', desc: 'Cup of Chai ☕' },
    { amt: 50, label: '₹50', desc: 'Hot Coffee ☕' },
    { amt: 100, label: '₹100', desc: 'Coffee & Snacks 🍩' },
    { amt: 250, label: '₹250', desc: 'Wolf Pack 🐺' },
  ];

  const chipsContainer = h('div', { class: 'creator-amt-chips' });
  const renderChips = () => {
    chipsContainer.replaceChildren(
      ...amounts.map((opt) => {
        const isSel = currentAmount === opt.amt;
        return h('button', {
          type: 'button',
          class: `creator-amt-chip${isSel ? ' active' : ''}`,
          onclick: () => {
            currentAmount = opt.amt;
            const url = makeUpiUrl(currentAmount);
            qrImg.src = `/api/qr.svg?d=${encodeURIComponent(url)}`;
            payLink.href = url;
            payLink.textContent = '';
            payLink.append(ic('rupee'), `Pay ₹${currentAmount} via UPI App`);
            renderChips();
          }
        }, h('b', {}, opt.label), h('span', { class: 'tiny' }, opt.desc));
      })
    );
  };
  renderChips();

  const copyBtn = h('button', {
    type: 'button',
    class: 'btn sm',
    onclick: () => copyText(upiId)
  }, ic('copy'), 'Copy UPI ID');

  bg = h('div', { class: 'modal-bg', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === bg) close(); } },
    h('div', { class: 'modal creator-modal' },
      h('div', { class: 'creator-modal-head' },
        h('div', { class: 'creator-head-left' },
          h('div', { class: 'creator-wolf-avatar' }, '🐺'),
          h('div', {},
            h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
              h('h3', { style: 'margin:0;font-size:18px' }, 'Created by SmartWolf'),
              h('span', { class: 'tag ok' }, 'Owner & Developer')
            ),
            h('p', { class: 'muted tiny', style: 'margin:3px 0 0' },
              'IT pro by day, Roblox streamer by passion 🐺 · Blox Fruits & Steal An Egg')
          )
        ),
        h('button', { type: 'button', class: 'btn sm ghost icon', title: 'Close', onclick: close }, '✕')
      ),
      h('div', { class: 'creator-free-callout' },
        h('span', { style: 'font-size:24px' }, '🎉'),
        h('div', {},
          h('b', {}, 'OmniChat is 100% Free Forever'),
          h('p', { class: 'muted tiny', style: 'margin:2px 0 0' },
            'Zero platform fee, no cuts from your donations, and no paid subscriptions. If this tool helps your live stream, consider supporting me with a cup of tea or coffee! ☕')
        )
      ),
      h('div', { class: 'creator-socials-grid' },
        h('a', { class: 'creator-social-btn yt', href: 'https://www.youtube.com/@smartwolf_yt', target: '_blank', rel: 'noopener' },
          ic('youtube'), h('div', {}, h('b', {}, 'YouTube Channel'), h('span', { class: 'tiny' }, '@smartwolf_yt · ~27K subs'))),
        h('a', { class: 'creator-social-btn insta', href: 'https://www.instagram.com/smartwolf_yt/', target: '_blank', rel: 'noopener' },
          ic('instagram'), h('div', {}, h('b', {}, 'Instagram'), h('span', { class: 'tiny' }, '@smartwolf_yt'))),
        h('a', { class: 'creator-social-btn kick', href: 'https://kick.com/smartwolfyt', target: '_blank', rel: 'noopener' },
          ICONS.kick, h('div', {}, h('b', {}, 'Kick Stream'), h('span', { class: 'tiny' }, 'kick.com/smartwolfyt'))),
        h('a', { class: 'creator-social-btn disc', href: 'https://discord.gg/smartwolfyt', target: '_blank', rel: 'noopener' },
          ic('discord'), h('div', {}, h('b', {}, 'Discord Community'), h('span', { class: 'tiny' }, 'discord.gg/smartwolfyt')))
      ),
      h('div', { class: 'creator-coffee-box' },
        h('div', { class: 'coffee-box-head' },
          h('span', { style: 'font-size:20px' }, '☕'),
          h('div', {},
            h('b', {}, 'Buy SmartWolf a Cup of Tea / Coffee'),
            h('p', { class: 'muted tiny', style: 'margin:1px 0 0' }, 'Scan QR code with GPay, PhonePe, Paytm or any UPI app')
          )
        ),
        chipsContainer,
        h('div', { class: 'creator-qr-row' },
          h('div', { class: 'creator-qr-wrap' }, qrImg),
          h('div', { class: 'creator-qr-meta' },
            h('div', { class: 'creator-upi-id-box' },
              h('span', { class: 'tiny muted' }, 'UPI ID:'),
              h('code', { class: 'creator-upi-code' }, upiId),
              copyBtn
            ),
            payLink,
            h('p', { class: 'muted tiny', style: 'margin:8px 0 0;line-height:1.4' },
              'Direct-to-bank UPI · 100% goes to hosting servers & continuous updates for the streaming community. Dil se shukriya! 💜')
          )
        )
      ),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' },
        h('button', { type: 'button', class: 'btn primary', onclick: close }, 'Awesome, Got it!')
      )
    )
  );

  document.body.append(bg);
}

// ═════════════════════════════════════════════════════════════════════
//  Routing / shell
// ═════════════════════════════════════════════════════════════════════
let prevPage = 'overview';
function showPage(p) {
  if (p === 'whats-new') {
    showWhatsNewModal();
    return;
  }
  if (p === 'creator') {
    showCreatorModal();
    return;
  }
  prevPage = PAGES[p] ? p : 'overview';
  page = prevPage;
  for (const id of Object.keys(PAGES)) $(`#page-${id}`).hidden = id !== page;
  $$('.nav-item').forEach((a) => a.classList.toggle('on', a.dataset.page === page));
  $('#page-title').textContent = PAGES[page][0];
  $('#page-sub').textContent = PAGES[page][1];
  document.title = `${PAGES[page][0]} · OmniChat`;
  $('#app').classList.remove('nav-open');
  if (page === 'overview') renderOverview();
  if (page === 'connections') renderConnections();
  if (page === 'logs') renderLogs();
  if (page === 'eggs') renderEggs();
  if (page === 'tools') renderTools();
  if (page === 'donations') {
    renderDonations();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }
  if (page === 'settings') renderSettings();
}
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));

function renderUser() {
  $('#user-name').textContent = me.user.name || 'Streamer';
  const n = me.accounts.length;
  $('#user-sub').textContent = `${n} platform${n === 1 ? '' : 's'} connected`;
  const av = $('#user-av');
  av.replaceChildren();
  if (me.user.avatar) av.append(h('img', { src: me.user.avatar, alt: '', referrerpolicy: 'no-referrer' }));
  else av.textContent = (me.user.name || '?')[0].toUpperCase();
}

// ═════════════════════════════════════════════════════════════════════
//  Live tools: highlight chat on stream, polls, bot commands & timers, stream summary
// ═════════════════════════════════════════════════════════════════════
const tools = { draft: null, hours: 6, chatUl: null, pollBox: null, poll: null };
const platIcon = (p) => h('span', { class: 'tplat', html: p === 'kick' ? ICONS.kick : ICONS.youtube });
const hasType = (t) => widgets.some((w) => w.type === t);
const needWidget = (t, what) => (hasType(t) ? null : h('div', { class: 'notice info' }, ic('info'), h('div', {},
  `${what} show up through an `, h('b', {}, `${TYPE_META[t][2]} widget`), '. ', h('a', { href: '#studio', onclick: () => setTimeout(newWidget, 50) }, `Create one in Studio`), ' and add its URL to OBS.')));

function renderToolChat() {
  const ul = tools.chatUl;
  if (!ul || page !== 'tools') return;
  const list = liveHistory.filter((m) => m.kind !== 'highlight' && m.kind !== 'highlight-clear').slice(-40).reverse();
  ul.replaceChildren(...(list.length ? list.map((m) => {
    const text = (m.parts || []).map((p) => (p.type === 'emote' ? `:${p.name}:` : p.text || '')).join('') || m.eventText || '';
    return h('li', { class: 'tmsg' + (m.kind && m.kind !== 'chat' ? ' ev' : '') }, platIcon(m.platform),
      h('div', { class: 'ttxt' }, h('b', {}, m.author?.name || ''), m.amount ? h('span', { class: 'tag ok' }, m.amount) : null, h('span', {}, ` ${text}`)),
      h('button', { type: 'button', class: 'btn sm', title: 'Show this message on stream (Alerts widget)', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await api('/api/tools/highlight', { method: 'POST', body: JSON.stringify({ id: m.id }) }); toast('Showing on stream'); } catch (err) { toast(err.message, 'err'); }
        e.currentTarget.disabled = false;
      } }, ic('star'), 'Show'));
  }) : [h('li', { class: 'empty' }, ic('message'), h('b', {}, 'No chat yet'), 'Messages from your live YouTube and Kick chat appear here.')]));
}

function pollCard(poll) {
  tools.poll = poll;
  const box = h('div', {});
  if (poll && (poll.open || Date.now() - poll.endsAt < 10 * 60_000)) {
    const left = Math.max(0, Math.ceil((poll.endsAt - Date.now()) / 1000));
    const max = Math.max(...poll.options.map((o) => o.votes));
    box.append(h('div', { class: 'tpoll' },
      h('div', { class: 'tpq' }, h('b', {}, poll.question), h('span', { class: `tag ${poll.open ? 'live' : ''}` }, poll.open ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'Ended')),
      poll.options.map((o, i) => {
        const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
        return h('div', { class: 'tbar' + (!poll.open && o.votes === max && max > 0 ? ' win' : '') },
          h('div', { class: 'tfill', style: `width:${pct}%` }), h('span', {}, `${i + 1}. ${o.text}`), h('b', {}, `${pct}% · ${o.votes}`));
      }),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px' },
        h('span', { class: 'muted tiny' }, `${poll.total} vote(s) · viewers type !vote 1–${poll.options.length}`),
        poll.open
          ? h('button', { type: 'button', class: 'btn sm danger', onclick: async () => { try { pollCard((await api('/api/tools/poll/end', { method: 'POST' })).poll); } catch (e) { toast(e.message, 'err'); } } }, 'End poll')
          : h('button', { type: 'button', class: 'btn sm', onclick: async () => { try { await api('/api/tools/poll', { method: 'DELETE' }); pollCard(null); } catch (e) { toast(e.message, 'err'); } } }, 'New poll'))));
  } else {
    const q = h('input', { class: 'input', maxlength: 120, placeholder: 'Question, e.g. Which egg do we hunt next?' });
    const opts = [1, 2, 3, 4].map((i) => h('input', { class: 'input', maxlength: 60, placeholder: i <= 2 ? `Option ${i}` : `Option ${i} (optional)` }));
    const mins = h('select', { class: 'select' }, [[1, '1 min'], [2, '2 min'], [3, '3 min'], [5, '5 min'], [10, '10 min'], [15, '15 min']].map(([v, l]) => h('option', { value: v, selected: v === 2 ? true : undefined }, l)));
    box.append(h('div', { class: 'tform' }, q, h('div', { class: 'tgrid2' }, opts), h('div', { class: 'row' }, h('span', { class: 'muted tiny' }, 'Duration'), mins,
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        try {
          const r = await api('/api/tools/poll', { method: 'POST', body: JSON.stringify({ question: q.value, options: opts.map((o) => o.value), minutes: Number(mins.value) }) });
          toast('Poll started — viewers vote with !vote 1, !vote 2 …');
          pollCard(r.poll);
        } catch (e) { toast(e.message, 'err'); }
      } }, 'Start poll'))));
  }
  tools.pollBox?.replaceChildren(box);
}

function commandsCard(cfg, part) {
  const isCmd = part === 'commands';
  const rows = h('div', { class: 'tlist' });
  const drawCmds = () => rows.replaceChildren(...(cfg.commands.length ? cfg.commands.map((c, i) => h('div', { class: 'tcmd' },
    h('input', { class: 'input', value: c.cmd, placeholder: '!discord', maxlength: 25, oninput: (e) => { c.cmd = e.target.value; } }),
    h('input', { class: 'input', value: c.reply, placeholder: 'Join our Discord: discord.gg/… (use {user} for the name)', maxlength: 400, oninput: (e) => { c.reply = e.target.value; } }),
    h('button', { type: 'button', class: 'btn sm ghost icon', title: 'Remove', 'aria-label': 'Remove', onclick: () => { cfg.commands.splice(i, 1); drawCmds(); } }, ic('trash')))) : [h('p', { class: 'muted tiny' }, 'No commands yet. Add one, e.g. !discord → your invite link.')]));
  const drawTimers = () => rows.replaceChildren(...(cfg.timers.length ? cfg.timers.map((t, i) => h('div', { class: 'tcmd' },
    h('input', { class: 'input', value: t.text, placeholder: 'Follow the channel and type !socials 💜', maxlength: 400, oninput: (e) => { t.text = e.target.value; } }),
    h('select', { class: 'select', onchange: (e) => { t.every = Number(e.target.value); } }, [5, 10, 15, 20, 30, 45, 60, 90, 120].map((v) => h('option', { value: v, selected: v === t.every ? true : undefined }, `every ${v} min`))),
    h('button', { type: 'button', class: 'btn sm ghost icon', title: 'Remove', 'aria-label': 'Remove', onclick: () => { cfg.timers.splice(i, 1); drawTimers(); } }, ic('trash')))) : [h('p', { class: 'muted tiny' }, 'No timers yet. A timer posts a message every few minutes while you are live.')]));
  (isCmd ? drawCmds : drawTimers)();
  const sw = (k, label) => h('label', { class: 'row', style: 'gap:8px' }, h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: cfg[k] ? true : undefined, onchange: (e) => { cfg[k] = e.target.checked; } }), h('span')), label);
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, ic(isCmd ? 'message' : 'clock'), h('h3', {}, isCmd ? 'Bot commands' : 'Timers'), h('div', { class: 'actions' }, sw('youtube', 'YouTube'), sw('kick', 'Kick'))),
    h('p', { class: 'muted tiny', style: 'margin-top:0;margin-bottom:10px' }, isCmd
      ? 'Viewers type a command (e.g. !discord) and the OmniChat bot replies in chat. {user} = the viewer’s name. 20 s cooldown per command.'
      : 'Each timer posts its message every N minutes, only while you are live.',
      ' YouTube allows about 60 bot messages a day (shared API quota); Kick has no limit.'),
    rows,
    h('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px' },
      h('button', { type: 'button', class: 'btn sm', onclick: () => {
        if (isCmd) { if (cfg.commands.length < 30) cfg.commands.push({ cmd: '!', reply: '', enabled: true }); drawCmds(); }
        else { if (cfg.timers.length < 10) cfg.timers.push({ text: '', every: 15, enabled: true }); drawTimers(); }
      } }, ic('plus'), isCmd ? 'Add command' : 'Add timer'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        try {
          const r = await api('/api/tools/settings', { method: 'PUT', body: JSON.stringify(cfg) });
          tools.draft = structuredClone(r.settings);
          toast(`Saved ${r.settings.commands.length} command(s), ${r.settings.timers.length} timer(s)`);
          renderTools();
        } catch (e) { toast(e.message, 'err'); }
      } }, 'Save')));
}

async function donateCard() {
  let r;
  try { r = await api('/api/tools/donate'); } catch (e) { return h('div', { class: 'card' }, h('p', {}, e.message)); }
  const cfg = { ...r.settings };
  const input = (k, attrs) => h('input', { class: 'input', value: cfg[k] ?? '', ...attrs, oninput: (e) => { cfg[k] = e.target.value; } });
  const amounts = h('input', { class: 'input', value: cfg.amounts.join(', '), placeholder: '50, 100, 200, 500', oninput: (e) => { cfg.amounts = e.target.value.split(/[ ,]+/).map(Number).filter(Boolean); } });
  const on = h('input', { type: 'checkbox', checked: cfg.enabled ? true : undefined, onchange: (e) => { cfg.enabled = e.target.checked; } });
  const save = async () => {
    try { await api('/api/tools/donate', { method: 'PUT', body: JSON.stringify({ ...cfg, min: Number(cfg.min) }) }); toast(cfg.enabled ? 'Donations ON — share your page link' : 'Saved'); renderDonations(); } catch (e) { toast(e.message, 'err'); }
  };
  const setup = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, ic('heart'), h('h3', {}, 'Donation box (UPI)'), h('div', { class: 'actions' }, h('label', { class: 'row', style: 'gap:8px' }, h('span', { class: 'switch' }, on, h('span')), 'Donations ON'))),
    h('p', { class: 'muted tiny', style: 'margin-top:0' }, 'Viewers pay straight to your UPI ID from GPay / PhonePe / Paytm. OmniChat never touches the money and cannot see payments, so you confirm each one below (Received) before it shows as an alert.'),
    h('div', { class: 'tgrid2' },
      h('label', { class: 'tfield' }, h('b', { class: 'tiny' }, 'Your UPI ID'), input('upi', { placeholder: 'yourname@upi', maxlength: 120, autocomplete: 'off', spellcheck: 'false' })),
      h('label', { class: 'tfield' }, h('b', { class: 'tiny' }, 'Name shown to donors'), input('payee', { placeholder: me.user.name || 'Your name', maxlength: 50 }))),
    h('label', { class: 'tfield' }, h('b', { class: 'tiny' }, 'Message on your page'), input('text', { maxlength: 200 })),
    h('div', { class: 'tgrid2' },
      h('label', { class: 'tfield' }, h('b', { class: 'tiny' }, 'Quick amounts (₹)'), amounts),
      h('label', { class: 'tfield' }, h('b', { class: 'tiny' }, 'Minimum (₹)'), input('min', { type: 'number', min: 1, max: 100000 }))),
    r.settings.enabled && r.settings.upi ? h('div', { class: 'notice ok' }, ic('link'), h('div', {}, 'Your donation page: ', h('a', { href: r.page, target: '_blank', rel: 'noopener' }, r.page), ' ',
      h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(r.page) }, ic('copy'), 'Copy'), h('br'), h('span', { class: 'muted tiny' }, 'Put it in your stream description / pinned chat. Add the Donate QR widget in Studio to show the QR on stream.'))) : null,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save')));
  const pending = r.items.filter((x) => x.status === 'pending');
  donationsPendingCountEl = h('span', { class: 'sub' }, `${pending.length} waiting for you`);
  donationsNotesUl = h('ul', { class: 'tchat' });
  renderDonationRows(r.items, donationsNotesUl, donationsPendingCountEl);
  const list = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, ic('heart'), h('h3', {}, 'Donation notes'), donationsPendingCountEl),
    h('p', { class: 'muted tiny', style: 'margin-top:0' }, 'Open your UPI app, check the money arrived, then press Received. The alert appears on your Alerts widget.'),
    donationsNotesUl);
  const mName = h('input', { class: 'input', maxlength: 40, placeholder: 'Name' });
  const mAmount = h('input', { class: 'input', type: 'number', min: 1, placeholder: 'Amount ₹' });
  const mMsg = h('input', { class: 'input', maxlength: 200, placeholder: 'Message (optional)' });
  const manual = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, ic('plus'), h('h3', {}, 'Add a donation by hand')),
    h('p', { class: 'muted tiny', style: 'margin-top:0' }, 'Someone paid your UPI ID directly (no note)? Check your UPI app, enter it here and the Donation alert shows on stream.'),
    h('div', { class: 'tmanual' }, mName, mAmount, mMsg, h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      try { await api('/api/tools/donate/manual', { method: 'POST', body: JSON.stringify({ name: mName.value, amount: Number(mAmount.value), message: mMsg.value }) }); toast('Donation alert sent to stream'); renderDonations(); } catch (e) { toast(e.message, 'err'); }
    } }, ic('send'), 'Show alert')));
  const creatorBanner = h('div', { class: 'card creator-sub-banner', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap' },
    h('div', { style: 'display:flex;align-items:center;gap:10px' },
      h('span', { style: 'font-size:24px' }, '☕'),
      h('div', {},
        h('b', {}, 'OmniChat takes 0% cut from your donations · 100% Free Tool'),
        h('p', { class: 'muted tiny', style: 'margin:2px 0 0' }, 'Created with ❤️ by SmartWolf. If you love this project, consider buying me a cup of tea or coffee!')
      )
    ),
    h('button', { type: 'button', class: 'btn sm', onclick: showCreatorModal }, ic('coffee'), 'Support SmartWolf ☕')
  );
  return h('div', { class: 'grid', style: 'gap:16px' }, setup, needWidget('donate', 'The QR code on stream'), list, manual, creatorBanner);
}

let donationsNotesUl = null;
let donationsPendingCountEl = null;
const seenDonationIds = new Set();
let isInitialDonationsPoll = true;

function renderDonationRows(items, ul, countEl) {
  const pending = (items || []).filter((x) => x.status === 'pending');
  const done = (items || []).filter((x) => x.status !== 'pending').slice(0, 20);
  if (countEl) countEl.textContent = `${pending.length} waiting for you`;
  const row = (x) => h('li', { class: 'tmsg', id: `don-row-${x.id}` }, h('span', { class: 'tag ok' }, `₹${x.amount}`),
    h('div', { class: 'ttxt' }, h('b', {}, x.name), x.message ? h('span', {}, ` — ${x.message}`) : null, h('span', { class: 'muted tiny' }, ` · ${ago(x.ts)}`)),
    x.status === 'pending' ? [
      h('button', { type: 'button', class: 'btn sm primary', title: 'Check your UPI app first. Shows the Donation alert on stream.', onclick: async () => { try { await api(`/api/tools/donate/${x.id}/confirm`, { method: 'POST' }); toast('Donation alert sent to stream'); renderDonations(); } catch (e) { toast(e.message, 'err'); } } }, ic('check'), 'Received'),
      h('button', { type: 'button', class: 'btn sm ghost', title: 'Not received / spam', onclick: async () => { try { await api(`/api/tools/donate/${x.id}`, { method: 'DELETE' }); renderDonations(); } catch (e) { toast(e.message, 'err'); } } }, 'Dismiss')]
      : h('span', { class: `tag ${x.status === 'received' ? 'ok' : ''}` }, x.status));
  if (!pending.length && !done.length) {
    ul.replaceChildren(h('p', { class: 'muted tiny', id: 'don-none' }, 'No donations yet.'));
  } else {
    ul.replaceChildren(...[...pending, ...done].map(row));
  }
}

function showIncomingDonationPopup(item) {
  try { synth('notify', 85); } catch { /* ignore */ }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(`New donation: ₹${item.amount} from ${item.name}`, {
        body: item.message ? `"${item.message}"` : 'Pending approval in OmniChat',
        icon: '/favicon.svg',
      });
      n.onclick = () => { window.focus(); };
    } catch { /* ignore */ }
  }

  if ($(`#don-pop-${item.id}`)) return;

  const popup = h('div', { class: 'toast toast-donation', id: `don-pop-${item.id}` },
    h('div', { class: 'toast-donation-head' },
      h('div', { class: 'toast-donation-title' },
        ic('heart'),
        h('b', {}, `₹${item.amount}`),
        h('span', {}, item.name)
      ),
      h('button', {
        type: 'button', class: 'btn sm ghost icon', title: 'Close', style: 'padding:2px 6px',
        onclick: () => { popup.classList.add('out'); setTimeout(() => popup.remove(), 250); }
      }, '✕')
    ),
    item.message ? h('div', { class: 'toast-donation-body' }, `“${item.message}”`) : null,
    h('div', { class: 'toast-donation-actions' },
      h('button', {
        type: 'button', class: 'btn sm ghost',
        onclick: async () => {
          try {
            await api(`/api/tools/donate/${item.id}`, { method: 'DELETE' });
            popup.classList.add('out'); setTimeout(() => popup.remove(), 250);
            toast('Donation dismissed');
            if (page === 'donations') renderDonations();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Dismiss'),
      h('button', {
        type: 'button', class: 'btn sm primary',
        onclick: async () => {
          try {
            await api(`/api/tools/donate/${item.id}/confirm`, { method: 'POST' });
            popup.classList.add('out'); setTimeout(() => popup.remove(), 250);
            toast('Donation alert sent to stream');
            if (page === 'donations') renderDonations();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, ic('check'), 'Received (Alert)')
    )
  );

  $('#toasts').append(popup);
  setTimeout(() => {
    if (popup.parentElement) {
      popup.classList.add('out');
      setTimeout(() => popup.remove(), 250);
    }
  }, 45_000);
}

function handleDonationsUpdate(items) {
  if (!Array.isArray(items)) return;
  const pending = items.filter((x) => x.status === 'pending');
  const b = $('#nav-donations');
  if (b) {
    b.textContent = pending.length;
    b.hidden = !pending.length;
  }
  if (page === 'donations' && donationsNotesUl && donationsNotesUl.isConnected) {
    renderDonationRows(items, donationsNotesUl, donationsPendingCountEl);
  }
  if (isInitialDonationsPoll) {
    items.forEach((x) => seenDonationIds.add(x.id));
    isInitialDonationsPoll = false;
    return;
  }
  for (const it of pending) {
    if (!seenDonationIds.has(it.id)) {
      seenDonationIds.add(it.id);
      showIncomingDonationPopup(it);
    }
  }
  for (const it of items) {
    if (it.status !== 'pending') {
      const pop = $(`#don-pop-${it.id}`);
      if (pop) { pop.classList.add('out'); setTimeout(() => pop.remove(), 250); }
    }
  }
}

async function renderDonations() {
  const root = $('#page-donations');
  const card = await donateCard();
  if (page === 'donations') root.replaceChildren(h('div', { class: 'tpanel' }, card));
  updateDonationBadge();
}
async function updateDonationBadge() {
  try {
    const r = await api('/api/tools/donate');
    const n = r.items.filter((x) => x.status === 'pending').length;
    const b = $('#nav-donations');
    b.textContent = n;
    b.hidden = !n;
  } catch { /* ignore */ }
}

async function summaryCard() {
  const body = h('div', {}, h('span', { class: 'muted tiny' }, 'Loading…'));
  const sel = h('select', { class: 'select', style: 'width:auto', onchange: (e) => { tools.hours = Number(e.target.value); load(); } },
    [[3, 'Last 3 h'], [6, 'Last 6 h'], [12, 'Last 12 h'], [24, 'Last 24 h'], [48, 'Last 48 h']].map(([v, l]) => h('option', { value: v, selected: v === tools.hours ? true : undefined }, l)));
  async function load() {
    let r;
    try { r = await api(`/api/tools/summary?hours=${tools.hours}`); } catch (e) { body.replaceChildren(h('span', { class: 'muted tiny' }, e.message)); return; }
    const tile = (label, val) => h('div', { class: 'tsum' }, h('b', {}, val), h('span', {}, label));
    const peak = r.peak?.peak ? fmtN(r.peak.peak) : '—';
    body.replaceChildren(...[
      r.historyOff ? h('div', { class: 'notice info' }, ic('info'), h('div', {}, 'Chat history is off (Settings), so the summary is empty. Turn it on to see stats.')) : null,
      h('div', { class: 'tsums' }, tile('Messages', fmtN(r.messages)), tile('Chatters', fmtN(r.chatters)), tile('Peak viewers', peak),
        tile('Super Chats', fmtN(r.superchats.length)), tile('New members', fmtN(r.members)), tile('Gifts', fmtN(r.giftedMembers + r.kickGifts)),
        tile('Kick subs', fmtN(r.kickSubs)), tile('Kick follows', fmtN(r.follows)), tile('UPI donations', fmtN(r.donations || 0))),
      h('div', { class: 'grid two', style: 'margin-top:12px' },
        h('div', {}, h('b', { class: 'tiny' }, 'Top chatters'), r.topChatters.length
          ? h('ol', { class: 'ttop' }, r.topChatters.map((c) => h('li', {}, platIcon(c.platform), h('span', {}, c.name), h('b', {}, fmtN(c.n)))))
          : h('p', { class: 'muted tiny' }, 'No messages yet.')),
        h('div', {}, h('b', { class: 'tiny' }, 'Super Chats'), r.superchats.length
          ? h('ul', { class: 'ttop' }, r.superchats.slice(0, 10).map((x) => h('li', {}, h('span', { class: 'tag ok' }, x.amount || '—'), h('span', {}, `${x.author}${x.text ? ` — ${x.text}` : ''}`))))
          : h('p', { class: 'muted tiny' }, 'None yet.')))].filter(Boolean));
  }
  load();
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('chart'), h('h3', {}, 'Stream summary'), h('div', { class: 'actions' }, sel)), body);
}

const TOOL_TABS = [['chat', 'Live chat', 'message'], ['poll', 'Chat poll', 'vote'], ['commands', 'Bot commands', 'message'], ['timers', 'Timers', 'clock'], ['summary', 'Stream summary', 'chart']];
async function renderTools() {
  const root = $('#page-tools');
  if (!tools.tab) { try { tools.tab = localStorage.getItem('omnichat.toolsTab') || 'chat'; } catch { tools.tab = 'chat'; } }
  if (!TOOL_TABS.some(([id]) => id === tools.tab)) tools.tab = 'chat';
  let data;
  try { data = await api('/api/tools'); } catch (e) { toast(e.message, 'err'); return; }
  if (page !== 'tools') return;
  tools.draft ||= structuredClone(data.settings);
  tools.chatUl = null;
  tools.pollBox = null;
  const tabs = h('div', { class: 'ttabs', role: 'tablist' }, TOOL_TABS.map(([id, label, ico]) => h('button', {
    type: 'button', role: 'tab', class: id === tools.tab ? 'on' : '', 'aria-selected': String(id === tools.tab),
    onclick: () => { tools.tab = id; try { localStorage.setItem('omnichat.toolsTab', id); } catch { /* ignore */ } renderTools(); },
  }, ic(ico), label)));
  let panel;
  if (tools.tab === 'chat') {
    tools.chatUl = h('ul', { class: 'tchat' });
    panel = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, ic('message'), h('h3', {}, 'Live chat'), h('span', { class: 'sub' }, 'Show = big card on stream (Alerts widget)'),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn sm ghost', onclick: async () => { try { await api('/api/tools/highlight', { method: 'DELETE' }); toast('Highlight hidden'); } catch (e) { toast(e.message, 'err'); } } }, 'Hide highlight'))),
      needWidget('alerts', 'Highlights'), tools.chatUl);
  } else if (tools.tab === 'poll') {
    tools.pollBox = h('div', {});
    panel = h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('chart'), h('h3', {}, 'Chat poll'), h('span', { class: 'sub' }, 'YouTube + Kick · one vote per viewer')),
      needWidget('poll', 'Polls'), tools.pollBox);
  } else if (tools.tab === 'commands' || tools.tab === 'timers') panel = commandsCard(tools.draft, tools.tab);
  else panel = await summaryCard();
  if (page !== 'tools') return;
  root.replaceChildren(tabs, h('div', { class: 'tpanel' }, panel));
  if (tools.chatUl) renderToolChat();
  if (tools.pollBox) pollCard(data.poll);
}
// keep the poll card fresh (votes + countdown) while the page is open
setInterval(async () => {
  if (page !== 'tools' || !tools.pollBox || document.activeElement?.closest('#page-tools .tform')) return;
  if (!tools.poll?.open) return;
  try { pollCard((await api('/api/tools')).poll); } catch { /* keep */ }
}, 2500);

// ── static wiring ──
document.addEventListener('click', (e) => { if (wselOpen && !e.target.closest('#widget-select')) { wselOpen = false; renderWidgetPicker(); } });
document.addEventListener('keydown', (e) => { if (wselOpen && e.key === 'Escape') { wselOpen = false; renderWidgetPicker(); } });
$('#widget-name').addEventListener('input', (e) => {
  if (!current) return;
  const v = e.target.value.trim();
  if (!v) return;
  current.name = v;
  scheduleSave();
  clearTimeout(renderWidgetPicker.t);
  renderWidgetPicker.t = setTimeout(renderWidgetPicker, 500);
});
$('#new-widget').addEventListener('click', newWidget);
$('#rotate').addEventListener('click', rotateWidget);
$$('#feed-mode button').forEach((b) => b.addEventListener('click', () => setFeed(b.dataset.v)));
$$('#backdrop button').forEach((b) => b.addEventListener('click', () => {
  $('#stage').className = 'stage bd-' + b.dataset.v;
  $$('#backdrop button').forEach((x) => x.classList.toggle('on', x === b));
}));
$('#clear').addEventListener('click', () => chatView.clear());
$('#copy').addEventListener('click', () => copyText($('#url').value));
$('#url').addEventListener('focus', (e) => e.target.select());
$('#logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.replace('/login');
});
$('#menu-btn').addEventListener('click', () => $('#app').classList.add('nav-open'));
$('#scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));
window.addEventListener('beforeunload', () => { if (saveTimer) saveNow(); });
setInterval(() => { if (page === 'logs') $$('#page-logs td.when').forEach((td) => { td.firstChild.textContent = ago(Number(td.dataset.ts)); }); }, 30_000);

// ── boot ──
async function boot() {
  hydrateIcons();
  bindThemeSwitch($('#theme-switch'));
  me = await api('/api/me');
  widgets = me.widgets;
  renderUser();

  let last = null;
  try { last = localStorage.getItem('omnichat.widget'); } catch { /* ignore */ }
  selectWidget(widgets.some((w) => w.id === last) ? last : widgets[0]?.id);

  const params = new URLSearchParams(location.search);
  if (params.get('error')) { toast(params.get('error'), 'err'); history.replaceState(null, '', '/' + location.hash); }

  connectLive('/api/poll', {
    onUnauthorized: (reason) => location.replace(signedOutUrl(reason)),
    onStatus: (ok) => { serverOk = ok; renderStatus(); },
    onState: (st) => {
      liveState = st;
      renderStatus();
      updateOverview();
      if (feedMode === 'live') { statsView.setState(st); goalView.setState(st); }
      if (page === 'connections' && !document.activeElement?.closest('#page-connections textarea, #page-connections details')) renderConnections();
    },
    onHistory: (list) => { liveHistory = list; if (feedMode === 'live') chatView.setHistory(list); },
    onChat: (m) => {
      if (m.kind === 'highlight' || m.kind === 'highlight-clear') { if (feedMode === 'live') alertsView.add(m); return; }
      liveHistory.push(m); if (liveHistory.length > 100) liveHistory.shift();
      if (feedMode === 'live') { chatView.add(m); alertsView.add(m); }
      if (page === 'tools') renderToolChat();
    },
    onDelete: (id) => { liveHistory = liveHistory.filter((m) => m.id !== id); if (feedMode === 'live') chatView.remove(id); },
    onLog: onLiveLog,
    onDonations: handleDonationsUpdate,
  });
  setFeed('demo');
  updateDonationBadge();
  $('#open-whats-new')?.addEventListener('click', showWhatsNewModal);
  $('#open-creator')?.addEventListener('click', showCreatorModal);
  $('#nav-creator')?.addEventListener('click', (e) => { e.preventDefault(); showCreatorModal(); });
  showPage(location.hash.slice(1) || 'overview');
  autoSyncKick();
  setInterval(() => autoSyncKick({ force: true }), 10 * 60_000); // keep the follower total fresh while the dashboard is open
}
boot().catch((e) => toast(e.message, 'err'));

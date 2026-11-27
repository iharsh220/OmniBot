// Shared settings: defaults, theme presets, URL encode/decode, CSS variables.

// Alert types that each get their own text, sound, custom sound URL and custom picture/GIF.
// [settings key part, default text, default sound]. Text variables: {name} {amount} {event} {count} {platform}.
export const ALERT_KINDS = [
  ['Superchat', 'Super Chat · {amount}', 'coin'],
  ['Member', '{event}', 'fanfare'],
  ['Gift', '{event}', 'sparkle'],
  ['KickSub', '{event}', 'levelup'],
  ['Follow', 'New follower', 'pop'],
  ['Greeting', '👋 Said hi', 'chime'],
  ['Highlight', '⭐ Highlight', 'bell'],
  ['Donation', 'Donation · {amount}', 'cash'],
];
export const ALERT_SOUNDS = ['default', 'chime', 'coin', 'fanfare', 'pop', 'sparkle', 'bell', 'levelup', 'whoosh', 'cash', 'airhorn', 'drumroll', 'laser', 'magic', 'notify', 'tada', 'bubble', 'powerup', 'heartbeat', 'none', 'custom'];
const alertKindDefaults = () => Object.fromEntries(ALERT_KINDS.flatMap(([k, text]) => [
  [`alert${k}Text`, text], [`alert${k}Sound`, 'default'], [`alert${k}SoundUrl`, ''], [`alert${k}Image`, ''],
]));

export const DEFAULTS = {
  // appearance
  theme: 'glass',
  font: 'Inter',
  fontSize: 16,
  fontWeight: 500,
  textColor: '#ffffff',
  msgBg: '#0d0d14',
  msgBgOpacity: 55,
  accent: '#8b5cf6',
  nameColor: 'user', // user | platform | accent | custom
  nameColorCustom: '#ffd166',
  pageBg: '#000000',
  pageBgOpacity: 0, // 0 = fully transparent (OBS)
  radius: 14,
  gap: 8,
  padding: 10,
  shadow: true,
  stroke: false,
  // chat content
  showAvatar: true,
  showBadges: true,
  showPlatform: true,
  showTime: false,
  animation: 'slide', // see ENUMS.animation (15 entry animations)
  animSpeed: 'normal', // fast | normal | slow
  direction: 'bottom', // bottom = newest at bottom, top = newest at top
  hideAfter: 0, // seconds, 0 = never
  maxMessages: 30,
  youtube: true,
  kick: true,
  hideCommands: false,
  hideBots: 'nightbot,streamelements,botrix,kickbot',
  // stats widget
  statsLayout: 'row', // row | column | pill
  statsYoutube: true,
  statsKick: true,
  statsTotal: true,
  statsViewers: true,
  statsSubs: true,
  statsLabels: true,
  statsCompact: false,
  statsHideOffline: false,
  statsHeader: 'both', // both | icon | name | none — what the card title shows
  statsLiveBadge: true,
  statsIcons: true, // 👁 / 👥 icons next to numbers
  statsNumSize: 100, // % number size
  statsAlign: 'left', // left | center
  statsViewersText: 'watching',
  statsSubsText: '', // empty = "subscribers" / "followers"
  statsTotalText: 'Total watching',
  // ── eggs widget (Steal an Egg spawns overlay) ──
  eggsLayout: 'board', // board (stock board by rarity) | list | grouped (per location) | spotlight (last spawn + events) | events
  eggsOrient: 'horizontal', // spotlight/events: horizontal (16:9 stream) | vertical (9:16 Shorts / TikTok)
  eggsEvents: true, // show game events (Tidal Surge, Butterfly Bloom, Slick Rick …)
  eggsEventsCount: 3, // how many events
  eggsEventDetails: true, // event summary + possible eggs / what it sells
  eggsAlertStyle: 'card', // alert look: card | banner | toast | neon | glass | minimal | big
  eggsAlertPos: 'top', // where the alert sits in the OBS source: top | center | bottom
  eggsEggLabel: '{rarity} egg spawned', // alert/hero kicker ({rarity} = Secret, Eternal …)
  eggsEventLabel: '⚡ EVENT', // tag on event alerts
  eggsFit: true,
  // ── alerts widget (Super Chat, members, Kick subs/follows, highlights). Look/time reuse eggsAlertStyle/eggsAlertPos/eggsPopup ──
  alertSuperchat: true, // Super Chats + Super Stickers
  alertMember: true, // new members + member milestones
  alertGift: true, // gifted memberships (YouTube) / gifted subs (Kick)
  alertKickSub: true, // Kick subs + resubs
  alertFollow: true, // Kick follows
  alertGreeting: true, // YouTube vertical-live "said hi"
  alertHighlight: true, // messages you highlight from the dashboard
  alertDonation: true, // UPI donations you confirm in Live tools → Donations
  alertMessage: true, // show the viewer's message on the alert
  alertSound: true, // short chime when an alert appears
  alertVolume: 60,
  alertCount: true, // "#3 this stream" badge on Super Chats, members, subs, follows …
  ...alertKindDefaults(),
  // ── goal widget ──
  goalType: 'youtube-subs', // youtube-subs | kick-followers | combined
  goalTarget: 1000,
  goalTitle: 'Subscriber goal',
  goalStyle: 'bar', // bar | slim
  goalPercent: true,
  goalNumbers: true,
  // ── donate widget (UPI QR on stream) ──
  donateTitle: 'Support the stream 💜',
  donateTitleColor: '#f4f6fb',
  donateTitleFont: 'inherit', // inherit | any FONTS key
  donateTitleSize: 125, // 70 - 260 %
  donateTitleWeight: 800, // 400 - 900
  donateShowBg: true,
  donateShowBorder: true,
  donateShowTitle: true,
  donateShowSub: true,
  donateShowUpi: true,
  donateShowLink: true,
  donateQr: 'page', // QR opens: page = your donation page (name + message, you get a note) | upi = UPI app directly
  donateUpiPos: 'side', // side | below-qr
  donateLayout: 'card', // card | qr-only | stacked
  donateQrSize: 150, // 80 - 320 px
  // ── poll widget ──
  pollHideIdle: true, // hide when there is no poll (and 60 s after it ended)
  pollHint: true, // "Type !vote 1 …" line // OBS: scale (and re-flow columns) so the whole overlay fits any resolution
  eggsPopup: 0, // alert: seconds each new egg/event stays (0 = latest always visible) · spotlight/events: pop up for X s
  eggsCount: 12, // how many eggs to show (list / grouped)
  eggsTiles: 40, // board: max tiles per rarity
  eggsLatest: true, // big card for the newest egg
  eggsTitle: 'Latest eggs', // list panel heading ('' = none)
  eggsDetails: true, // money / speed
  eggsLocation: true, // location next to each egg (list layout)
  eggsNewMinutes: 5, // highlight eggs younger than this
  eggsHideAfter: 0, // seconds an egg/event stays on screen (0 = never hidden; was eggsMaxAge in minutes)
  eggsColumns: 4, // board / grouped layout columns
  // ── extra style ──
  borderWidth: 0, // px, 0 = none
  borderColor: '#ffffff',
  borderOpacity: 25,
  lineHeight: 135, // ÷100 → 1.35
  nameWeight: 800,
  avatarShape: 'circle', // circle | rounded | square
  avatarSize: 100, // % of normal
  // ── extra layout ──
  align: 'left', // left | right
  maxWidth: 100, // % of the widget width
  compact: false, // name + message on one line
  // ── extra content ──
  showEvents: true, // Super Chats, memberships, subs
  timeFormat: '24h', // 24h | 12h
  emoteSize: 175, // % of the text size
  // ── extra filters ──
  hideLinks: false,
  blockedWords: '',
  minLength: 0, // hide messages shorter than this
  maxLength: 0, // shorten longer messages (0 = never)
};

export const THEMES = [
  { id: 'glass', name: 'Glass', desc: 'Frosted blur cards', values: { font: 'Inter', fontWeight: 500, textColor: '#ffffff', msgBg: '#0d0d14', msgBgOpacity: 55, accent: '#8b5cf6', radius: 14, nameColor: 'user', showAvatar: true } },
  { id: 'bubble', name: 'Bubble', desc: 'Messenger style', values: { font: 'Poppins', fontWeight: 500, textColor: '#1b1b1f', msgBg: '#ffffff', msgBgOpacity: 96, accent: '#ff4d8d', radius: 18, nameColor: 'user', showAvatar: true } },
  { id: 'neon', name: 'Neon', desc: 'Glowing cyber edges', values: { font: 'Outfit', fontWeight: 500, textColor: '#e9f9ff', msgBg: '#05010d', msgBgOpacity: 80, accent: '#00e5ff', radius: 10, nameColor: 'user', showAvatar: true } },
  { id: 'minimal', name: 'Minimal', desc: 'Clean outlined text', values: { font: 'Nunito', fontWeight: 700, fontSize: 18, textColor: '#ffffff', msgBgOpacity: 0, accent: '#ffffff', nameColor: 'user', showAvatar: false, stroke: true } },
  { id: 'card', name: 'Card', desc: 'Solid white cards', values: { font: 'Rubik', fontWeight: 500, textColor: '#1f2330', msgBg: '#ffffff', msgBgOpacity: 100, accent: '#ff6b35', radius: 12, nameColor: 'accent', showAvatar: true, stroke: false } },
  { id: 'retro', name: 'Retro', desc: 'Old-school terminal', values: { font: 'VT323', fontWeight: 400, fontSize: 22, textColor: '#39ff14', msgBg: '#000000', msgBgOpacity: 85, accent: '#39ff14', radius: 0, nameColor: 'user', showAvatar: false, stroke: false } },
  { id: 'sticker', name: 'Sticker', desc: 'Bold neo-brutalism', values: { font: 'Rubik', fontWeight: 600, textColor: '#111111', msgBg: '#fff6d6', msgBgOpacity: 100, accent: '#ffd23f', radius: 12, nameColor: 'accent', showAvatar: true, stroke: false } },
  { id: 'gradient', name: 'Gradient', desc: 'Vibrant name pills', values: { font: 'Montserrat', fontWeight: 500, textColor: '#ffffff', msgBg: '#14121f', msgBgOpacity: 85, accent: '#ff3cac', radius: 16, nameColor: 'user', showAvatar: true, stroke: false } },
  { id: 'pastel', name: 'Pastel', desc: 'Soft & friendly', values: { font: 'Comfortaa', fontWeight: 700, textColor: '#3b2f4a', msgBg: '#f6eefe', msgBgOpacity: 94, accent: '#b892ff', radius: 22, nameColor: 'accent', showAvatar: true, stroke: false } },
  { id: 'sleek', name: 'Sleek', desc: 'Dark strip, platform bar', values: { font: 'JetBrains Mono', fontWeight: 500, fontSize: 15, textColor: '#e6e6e6', msgBg: '#101014', msgBgOpacity: 92, accent: '#ffffff', radius: 4, nameColor: 'user', showAvatar: false, stroke: false } },
  { id: 'midnight', name: 'Midnight', desc: 'Calm app-style chat', values: { font: 'Inter', fontWeight: 500, fontSize: 15, textColor: '#dbdee1', msgBg: '#313338', msgBgOpacity: 92, accent: '#5865f2', radius: 8, nameColor: 'user', showAvatar: true, stroke: false } },
  { id: 'cyber', name: 'Cyber', desc: 'Yellow-black futuristic', values: { font: 'Outfit', fontWeight: 600, fontSize: 16, textColor: '#fdf500', msgBg: '#0b0b0f', msgBgOpacity: 90, accent: '#fdf500', radius: 0, nameColor: 'accent', showAvatar: false, stroke: false } },
  { id: 'pixel', name: 'Pixel', desc: '8-bit game boxes', values: { font: 'Press Start 2P', fontWeight: 400, fontSize: 11, textColor: '#ffffff', msgBg: '#1b1b3a', msgBgOpacity: 95, accent: '#ff5ccd', radius: 0, nameColor: 'user', showAvatar: false, stroke: false } },
  { id: 'comic', name: 'Comic', desc: 'Speech bubbles, bold ink', values: { font: 'Bangers', fontWeight: 400, fontSize: 20, textColor: '#111111', msgBg: '#ffffff', msgBgOpacity: 100, accent: '#ff3b3b', radius: 18, nameColor: 'accent', showAvatar: true, stroke: false } },
  { id: 'frost', name: 'Frost', desc: 'Icy glass, soft glow', values: { font: 'Nunito', fontWeight: 700, fontSize: 16, textColor: '#f0faff', msgBg: '#7cc7ff', msgBgOpacity: 22, accent: '#bfe8ff', radius: 16, nameColor: 'user', showAvatar: true, stroke: false } },
  { id: 'sunset', name: 'Sunset', desc: 'Warm gradient cards', values: { font: 'Poppins', fontWeight: 600, fontSize: 16, textColor: '#ffffff', msgBg: '#ff7a59', msgBgOpacity: 92, accent: '#ffd166', radius: 14, nameColor: 'accent', showAvatar: true, stroke: false } },
];

export const FONTS = {
  Inter: '400;500;600;700;800',
  Poppins: '400;500;600;700;800',
  Montserrat: '400;500;600;700;800',
  Nunito: '400;600;700;800',
  Rubik: '400;500;600;700;800',
  Outfit: '400;500;600;700;800',
  Roboto: '400;500;700;900',
  Comfortaa: '400;500;600;700',
  'Fira Code': '400;500;600;700',
  'JetBrains Mono': '400;500;600;700;800',
  VT323: '',
  'Press Start 2P': '',
  Bangers: '',
};

export const PLATFORM_COLORS = { youtube: '#ff3b3b', kick: '#53fc18' };

const isColor = (v) => /^#[0-9a-f]{6}$/i.test(v);

export function encodeSettings(s) {
  const p = new URLSearchParams();
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = s[k];
    if (v === undefined || v === def) continue;
    if (typeof def === 'boolean') p.set(k, v ? '1' : '0');
    else if (typeof def === 'string' && def.startsWith('#')) p.set(k, String(v).replace('#', ''));
    else p.set(k, String(v));
  }
  return p.toString();
}

// Allowed values / ranges — enforced in the browser AND on the server (server imports this file).
const ENUMS = {
  theme: THEMES.map((t) => t.id),
  font: Object.keys(FONTS),
  nameColor: ['user', 'platform', 'accent', 'custom'],
  animation: ['slide', 'slide-right', 'rise', 'drop', 'fade', 'pop', 'zoom', 'bounce', 'elastic', 'flip', 'swing', 'blur', 'wipe', 'glitch', 'none'],
  animSpeed: ['fast', 'normal', 'slow'],
  direction: ['bottom', 'top'],
  statsLayout: ['row', 'column', 'pill'],
  avatarShape: ['circle', 'rounded', 'square'],
  align: ['left', 'right'],
  timeFormat: ['24h', '12h'],
  statsHeader: ['both', 'icon', 'name', 'none'],
  statsAlign: ['left', 'center'],
  eggsLayout: ['board', 'list', 'grouped', 'spotlight', 'events', 'alert'],
  ...Object.fromEntries(ALERT_KINDS.map(([k]) => [`alert${k}Sound`, ALERT_SOUNDS])),
  eggsOrient: ['horizontal', 'vertical'],
  eggsAlertStyle: ['card', 'banner', 'toast', 'neon', 'glass', 'minimal', 'big'],
  eggsAlertPos: ['top', 'center', 'bottom'],
  goalType: ['youtube-subs', 'kick-followers', 'combined'],
  goalStyle: ['bar', 'slim'],
  donateQr: ['page', 'upi'],
  donateUpiPos: ['side', 'below-qr'],
  donateLayout: ['card', 'qr-only', 'stacked'],
  donateTitleFont: ['inherit', ...Object.keys(FONTS)],
};
const RANGES = {
  fontSize: [8, 60], fontWeight: [100, 900], msgBgOpacity: [0, 100], pageBgOpacity: [0, 100],
  radius: [0, 40], gap: [0, 40], padding: [0, 40], hideAfter: [0, 600], maxMessages: [1, 200],
  borderWidth: [0, 8], borderOpacity: [0, 100], lineHeight: [100, 220], nameWeight: [400, 900], avatarSize: [50, 220],
  maxWidth: [30, 100], emoteSize: [80, 400], minLength: [0, 100], maxLength: [0, 500], statsNumSize: [60, 250],
  eggsCount: [1, 50], eggsTiles: [1, 80], eggsNewMinutes: [0, 120], eggsHideAfter: [0, 86400], eggsColumns: [1, 6], eggsEventsCount: [1, 10], eggsPopup: [0, 300], alertVolume: [0, 100], goalTarget: [1, 100000000],
  donateQrSize: [80, 320],
  donateTitleSize: [70, 260],
  donateTitleWeight: [400, 900],
};
const MAX_TEXT = { hideBots: 500, blockedWords: 500, statsViewersText: 30, statsSubsText: 30, statsTotalText: 30, eggsTitle: 40, eggsEggLabel: 40, eggsEventLabel: 24, goalTitle: 40, donateTitle: 50,
  ...Object.fromEntries(ALERT_KINDS.flatMap(([k]) => [[`alert${k}Text`, 80], [`alert${k}SoundUrl`, 400], [`alert${k}Image`, 400]])),
};
/** Safe https URL from a settings field (custom sounds/pictures), else null. */
export const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>()\\]{4,400}$/.test(u.trim()) ? u.trim() : null);
/** A file the streamer uploaded (/api/media/<id>) or an https URL, else null. */
export const mediaUrl = (u) => (typeof u === 'string' && /^\/api\/media\/[\w-]{8,40}$/.test(u.trim()) ? u.trim() : httpsUrl(u));

/** Starting looks for new widgets (merged over DEFAULTS). Used by Studio "new widget" and the server's default widgets. */
export const WIDGET_PRESETS = {
  chat: {},
  stats: {},
  eggs: { theme: 'midnight', font: 'Inter', fontSize: 15, fontWeight: 500, nameWeight: 800, textColor: '#f4f6fb', msgBg: '#0f1426', msgBgOpacity: 92, accent: '#4ade80', radius: 10, padding: 10, gap: 8, shadow: true, pageBgOpacity: 0 },
  alerts: { theme: 'midnight', font: 'Inter', fontSize: 17, textColor: '#f4f6fb', msgBg: '#0f1426', msgBgOpacity: 94, accent: '#a78bfa', radius: 14, shadow: true, pageBgOpacity: 0, eggsPopup: 8, eggsAlertStyle: 'card', eggsAlertPos: 'top', animation: 'pop' },
  goal: { theme: 'midnight', font: 'Inter', fontSize: 16, textColor: '#f4f6fb', msgBg: '#0f1426', msgBgOpacity: 92, accent: '#a78bfa', radius: 12, shadow: true, pageBgOpacity: 0 },
  poll: { theme: 'midnight', font: 'Inter', fontSize: 16, textColor: '#f4f6fb', msgBg: '#0f1426', msgBgOpacity: 92, accent: '#a78bfa', radius: 12, shadow: true, pageBgOpacity: 0 },
  donate: { theme: 'midnight', font: 'Inter', fontSize: 16, textColor: '#f4f6fb', msgBg: '#0f1426', msgBgOpacity: 92, accent: '#22c55e', radius: 14, shadow: true, pageBgOpacity: 0, donateLayout: 'card', donateUpiPos: 'side', donateQrSize: 150, donateShowTitle: true, donateShowSub: true, donateShowUpi: true, donateShowLink: true },
};
export const DEFAULT_WIDGETS = [['chat', 'My chat'], ['stats', 'My stats'], ['alerts', 'My alerts'], ['eggs', 'Egg tracker'], ['goal', 'My goal'], ['poll', 'My poll'], ['donate', 'Donate QR']];

function validValue(k, v, def) {
  if (typeof v !== typeof def) return undefined;
  if (typeof def === 'number') {
    if (!Number.isFinite(v)) return undefined;
    const [lo, hi] = RANGES[k] || [-1e6, 1e6];
    return Math.min(hi, Math.max(lo, Math.round(v)));
  }
  if (typeof def === 'string') {
    if (def.startsWith('#')) return isColor(v) ? v.toLowerCase() : undefined;
    if (ENUMS[k]) return ENUMS[k].includes(v) ? v : undefined;
    return v.replace(/[<>\u0000-\u001f]/g, '').slice(0, MAX_TEXT[k] || 100);
  }
  return v; // boolean
}

/** Merge settings with defaults: unknown keys dropped, wrong types/values rejected, numbers clamped. */
export function normalizeSettings(obj = {}) {
  const s = { ...DEFAULTS };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return s;
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = validValue(k, obj[k], def);
    if (v !== undefined) s[k] = v;
  }
  // Widgets saved before "Hide after" had seconds: minutes → seconds.
  if (!(s.eggsHideAfter > 0) && Number(obj.eggsMaxAge) > 0) s.eggsHideAfter = validValue('eggsHideAfter', Number(obj.eggsMaxAge) * 60, 0) ?? 0;
  return s;
}

/** Read settings from a query string, on top of `base` (defaults if omitted). */
export function decodeSettings(search, base = DEFAULTS) {
  const p = new URLSearchParams(search);
  const s = { ...DEFAULTS, ...base };
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!p.has(k)) continue;
    const raw = p.get(k);
    if (typeof def === 'boolean') s[k] = raw === '1' || raw === 'true';
    else if (typeof def === 'number') s[k] = Number(raw);
    else if (def.startsWith('#')) s[k] = '#' + raw.replace('#', '');
    else s[k] = raw;
  }
  if (p.has('eggsHideAfter')) delete s.eggsMaxAge;
  else if (p.has('eggsMaxAge')) { s.eggsHideAfter = 0; s.eggsMaxAge = Number(p.get('eggsMaxAge')); }
  return normalizeSettings(s);
}

export function hexA(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(100, pct)) / 100})`;
}

export function loadFont(name) {
  if (!(name in FONTS)) return;
  const id = 'gf-' + name.replace(/\s+/g, '-');
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  const w = FONTS[name];
  link.href = `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}${w ? ':wght@' + w : ''}&display=swap`;
  document.head.append(link);
}

/** Apply theme class + CSS variables to a widget root element. */
export function applyRoot(el, s, kind) {
  loadFont(s.font);
  el.className = [
    'ow-root', `ow-${kind}`, `theme-${s.theme}`, `anim-${s.animation}`, `speed-${s.animSpeed}`, `dir-${s.direction}`,
    `stats-${s.statsLayout}`, s.shadow ? 'has-shadow' : '', s.stroke ? 'has-stroke' : '',
    `av-${s.avatarShape}`, `align-${s.align}`, `stats-align-${s.statsAlign}`, `eggs-${s.eggsLayout}`, `eggs-${s.eggsOrient}`, `alert-${s.eggsAlertStyle}`, `alert-pos-${s.eggsAlertPos}`, `goal-${s.goalStyle}`, `donate-${s.donateLayout || 'card'}`, s.compact ? 'compact' : '', s.borderWidth > 0 ? 'has-border' : '',
  ].filter(Boolean).join(' ');
  const vars = {
    '--font': `'${s.font}', system-ui, sans-serif`,
    '--fs': `${s.fontSize}px`,
    '--fw': s.fontWeight,
    '--text': s.textColor,
    '--msg-bg': hexA(s.msgBg, s.msgBgOpacity),
    '--msg-bg-solid': s.msgBg,
    '--accent': s.accent,
    '--page-bg': hexA(s.pageBg, s.pageBgOpacity),
    '--radius': `${s.radius}px`,
    '--gap': `${s.gap}px`,
    '--pad': `${s.padding}px`,
    '--border-w': `${s.borderWidth}px`,
    '--border-c': hexA(s.borderColor, s.borderOpacity),
    '--lh': s.lineHeight / 100,
    '--name-w': s.nameWeight,
    '--av-scale': s.avatarSize / 100,
    '--maxw': `${s.maxWidth}%`,
    '--emote': s.emoteSize / 100,
    '--stat-num': s.statsNumSize / 100,
    '--egg-cols': s.eggsColumns,
    '--dqr-size': `${s.donateQrSize || 150}px`,
    '--dtitle-c': s.donateTitleColor || s.textColor,
    '--dtitle-size': (s.donateTitleSize || 125) / 100,
    '--dtitle-w': s.donateTitleWeight || 800,
    '--dtitle-font': s.donateTitleFont && s.donateTitleFont !== 'inherit' && FONTS[s.donateTitleFont] ? FONTS[s.donateTitleFont] : 'inherit',
  };
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

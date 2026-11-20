// Shared settings: defaults, theme presets, URL encode/decode, CSS variables.

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
  animation: 'slide', // slide | fade | pop | none
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
  eggsLayout: 'board', // board (stock board by rarity) | list | grouped (panels per location)
  eggsCount: 12, // how many eggs to show (list / grouped)
  eggsTiles: 40, // board: max tiles per rarity
  eggsLatest: true, // big card for the newest egg
  eggsTitle: 'Latest eggs', // list panel heading ('' = none)
  eggsDetails: true, // money / speed
  eggsLocation: true, // location next to each egg (list layout)
  eggsNewMinutes: 5, // highlight eggs younger than this
  eggsMaxAge: 0, // hide eggs older than X minutes (0 = never)
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
  animation: ['slide', 'fade', 'pop', 'none'],
  direction: ['bottom', 'top'],
  statsLayout: ['row', 'column', 'pill'],
  avatarShape: ['circle', 'rounded', 'square'],
  align: ['left', 'right'],
  timeFormat: ['24h', '12h'],
  statsHeader: ['both', 'icon', 'name', 'none'],
  statsAlign: ['left', 'center'],
  eggsLayout: ['board', 'list', 'grouped'],
};
const RANGES = {
  fontSize: [8, 60], fontWeight: [100, 900], msgBgOpacity: [0, 100], pageBgOpacity: [0, 100],
  radius: [0, 40], gap: [0, 40], padding: [0, 40], hideAfter: [0, 600], maxMessages: [1, 200],
  borderWidth: [0, 8], borderOpacity: [0, 100], lineHeight: [100, 220], nameWeight: [400, 900], avatarSize: [50, 220],
  maxWidth: [30, 100], emoteSize: [80, 400], minLength: [0, 100], maxLength: [0, 500], statsNumSize: [60, 250],
  eggsCount: [1, 50], eggsTiles: [1, 80], eggsNewMinutes: [0, 120], eggsMaxAge: [0, 1440], eggsColumns: [1, 6],
};
const MAX_TEXT = { hideBots: 500, blockedWords: 500, statsViewersText: 30, statsSubsText: 30, statsTotalText: 30, eggsTitle: 40 };

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
    'ow-root', `ow-${kind}`, `theme-${s.theme}`, `anim-${s.animation}`, `dir-${s.direction}`,
    `stats-${s.statsLayout}`, s.shadow ? 'has-shadow' : '', s.stroke ? 'has-stroke' : '',
    `av-${s.avatarShape}`, `align-${s.align}`, `stats-align-${s.statsAlign}`, `eggs-${s.eggsLayout}`, s.compact ? 'compact' : '', s.borderWidth > 0 ? 'has-border' : '',
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
  };
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

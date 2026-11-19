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

/** Merge stored settings with defaults, dropping unknown keys / wrong types. */
export function normalizeSettings(obj = {}) {
  const s = { ...DEFAULTS };
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = obj?.[k];
    if (v === undefined || typeof v !== typeof def) continue;
    if (typeof def === 'string' && def.startsWith('#') && !isColor(v)) continue;
    s[k] = v;
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
    else if (typeof def === 'number') { const n = Number(raw); if (!Number.isNaN(n)) s[k] = n; }
    else if (def.startsWith('#')) { const c = '#' + raw.replace('#', ''); if (isColor(c)) s[k] = c; }
    else s[k] = raw;
  }
  return s;
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
  };
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

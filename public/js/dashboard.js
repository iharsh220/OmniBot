import { DEFAULTS, THEMES, FONTS, applyRoot, normalizeSettings } from './settings.js';
import { ChatView, StatsView, createMessageEl, ICONS } from './render.js';
import { connectLive, startDemo } from './feed.js';
import { icon, hydrateIcons, bindThemeSwitch } from './icons.js';

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

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) {
    const me = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    if (me && me.status === 401) {
      const j = await me.json().catch(() => ({}));
      location.replace('/login?error=' + encodeURIComponent(`Signed out (${j.reason || 'session ended'}). Please sign in again.`));
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
};
const SECTION_INFO = {
  theme: () => ['10 ready-made looks — pick one to start'],
  style: () => ['Colors, border, background, fonts, shape & avatar'],
  layout: (type) => [type === 'chat' ? 'Alignment, width, animation & timing' : 'Row, column or pill · alignment'],
  content: (type) => [type === 'chat' ? 'Avatar, badges, time, events & emotes' : 'Viewers, subs, total · titles, icons & labels'],
  filters: () => ['Platforms, commands, users, links, words & length'],
};

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
    { k: 'animation', t: 'seg', label: 'Animation', options: [['slide', 'Slide'], ['fade', 'Fade'], ['pop', 'Pop'], ['none', 'None']] },
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
    { k: 'statsIcons', t: 'toggle', label: 'Icons (👁 👥)' },
    { k: 'statsLabels', t: 'toggle', label: 'Labels' },
    { k: 'statsViewersText', t: 'text', label: 'Viewers label', placeholder: 'watching', show: (s) => s.statsLabels && s.statsViewers },
    { k: 'statsSubsText', t: 'text', label: 'Subs label', placeholder: 'auto: subscribers / followers', show: (s) => s.statsLabels && s.statsSubs },
    { k: 'statsTotalText', t: 'text', label: 'Total card title', placeholder: 'Total watching', show: (s) => s.statsTotal && s.statsViewers },
    { k: 'statsCompact', t: 'toggle', label: 'Compact numbers', hint: '15,320 → 15.3K' },
    { k: 'statsNumSize', t: 'range', label: 'Number size', min: 60, max: 200, unit: '%' },
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
      sel.addEventListener('change', () => set(f.k, f.num ? Number(sel.value) : sel.value));
      return sel;
    }
    case 'seg':
      return h('div', { class: 'seg full', role: 'group', 'aria-label': f.label }, f.options.map(([val, label]) =>
        h('button', { type: 'button', class: val === v ? 'on' : '', onclick: () => set(f.k, val, { rebuild: true }) }, label)));
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

function renderWidgetPicker() {
  $('#widget-select').replaceChildren(...widgets.map((w) => {
    const o = h('option', { value: w.id }, `${w.type === 'chat' ? '💬' : '📊'}  ${w.name}`);
    if (w.id === current?.id) o.selected = true;
    return o;
  }));
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
  saveState('');
  renderWidgetPicker();
  renderConfig();
  refreshPreview();
}

async function newWidget() {
  const picker = h('div', { class: 'seg full', 'data-value': 'chat' },
    h('button', { type: 'button', class: 'on', 'data-v': 'chat' }, ic('message'), 'Chat'),
    h('button', { type: 'button', 'data-v': 'stats' }, ic('chart'), 'Stats'));
  picker.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    picker.dataset.value = b.dataset.v;
    $$('button', picker).forEach((x) => x.classList.toggle('on', x === b));
  });
  const type = await dialog({ title: 'New widget', text: 'Each widget gets its own URL and design. Use several for different scenes.', confirm: 'Create widget', content: picker });
  if (!type) return;
  try {
    const n = widgets.filter((x) => x.type === type).length + 1;
    const w = await api('/api/widgets', { method: 'POST', body: JSON.stringify({ type, name: `${type === 'chat' ? 'Chat' : 'Stats'} ${n}`, settings: current ? settings : {} }) });
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

function refreshPreview() {
  chatView.setSettings({ ...settings });
  statsView.setSettings({ ...settings });
  if (feedMode === 'live') statsView.setState(liveState || {});
  const url = current ? widgetUrl(current) : '';
  $('#url').value = url;
  $('#open').href = url || '#';
  $('#size-hint').textContent = current?.type === 'stats' ? (settings.statsLayout === 'column' ? '320 × 300' : '800 × 140') : '400 × 700';
}

function setFeed(mode) {
  feedMode = mode;
  demo?.stop();
  demo = null;
  chatView.clear();
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
    h('div', {}, h('h2', {}, `${greet}, ${me.user.name || 'streamer'} 👋`),
      h('p', {}, 'Your overlays are ready. Open Studio to tweak the look, or copy a URL straight into OBS.')),
    h('div', { class: 'actions' },
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
      h('div', { class: 'wicon', html: icon(w.type === 'chat' ? 'message' : 'chart') }),
      h('div', { class: 'meta' }, h('b', {}, w.name), h('code', {}, widgetUrl(w))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn sm', title: 'Copy URL', onclick: () => copyText(widgetUrl(w)) }, ic('copy'), 'Copy'),
        h('button', { class: 'btn sm ghost icon', title: 'Customize', 'aria-label': 'Customize', onclick: () => { selectWidget(w.id); location.hash = 'studio'; } }, ic('palette')))))));

  const feed = h('ul', { class: 'feed' }, h('li', {}, h('span', { class: 'muted tiny' }, 'Loading…')));
  ov.feed = feed;
  const activity = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Recent activity'), h('div', { class: 'actions' }, h('a', { class: 'btn sm ghost', href: '#logs' }, 'View all'))), feed);

  root.replaceChildren(hero,
    h('div', { class: 'section-title' }, h('h2', {}, 'Live now')),
    h('div', { class: 'grid kpis' }, ov.yt.card, ov.kk.card, ov.tot.card, ov.msgs.card),
    h('div', { class: 'grid two', style: 'margin-top:16px' }, wl, h('div', { class: 'grid', style: 'align-content:start' }, checklist, activity)));
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
      if (p === 'youtube' && st.subscribersMode === 'live' && st.subscribersConfirmed != null) {
        body.append(h('div', { class: 'notice ok' }, ic('users'), h('div', {},
          `Live subscribers ≈ ${fmtN(st.subscribers)} · confirmed ${fmtN(st.subscribersConfirmed)} (YouTube Analytics is 2–3 days behind, the gap is estimated from your daily growth).`)));
      }
      if (p === 'youtube' && st.connected && st.subscribers != null && !st.subscribersExact) {
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
      h('b', {}, `➕ Add ${!yc ? 'YouTube' : 'Kick'}`),
      h('span', {}, `Connect ${!yc ? 'YouTube' : 'Kick'} to use the Egg Bot there too.`)),
      h('a', { class: 'btn sm', href: '#connections' }, 'Connect')) : null,
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
    h('div', { class: 'srow' }, h('div', { class: 'txt' }, h('b', {}, '💡 Tip'), h('span', {}, 'Make the OmniChat Bot a moderator on your YouTube channel so slow mode never blocks it.'))));

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

  root.replaceChildren(h('div', { class: 'grid two' },
    h('div', { class: 'grid', style: 'align-content:start' }, botCard, settingsCard),
    h('div', { class: 'grid', style: 'align-content:start' }, checklist, history)));
}
setInterval(() => { if (page === 'eggs' && !document.activeElement?.closest('#page-eggs input')) renderEggs(); }, 10_000);

// ═════════════════════════════════════════════════════════════════════
//  Routing / shell
// ═════════════════════════════════════════════════════════════════════
function showPage(p) {
  page = PAGES[p] ? p : 'overview';
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

// ── static wiring ──
$('#widget-select').addEventListener('change', (e) => selectWidget(e.target.value));
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
    onUnauthorized: (reason) => location.replace('/login?error=' + encodeURIComponent(`Signed out (${reason || 'session ended'}). Please sign in again.`)),
    onStatus: (ok) => { serverOk = ok; renderStatus(); },
    onState: (st) => {
      liveState = st;
      renderStatus();
      updateOverview();
      if (feedMode === 'live') statsView.setState(st);
      if (page === 'connections' && !document.activeElement?.closest('#page-connections textarea, #page-connections details')) renderConnections();
    },
    onHistory: (list) => { liveHistory = list; if (feedMode === 'live') chatView.setHistory(list); },
    onChat: (m) => { liveHistory.push(m); if (liveHistory.length > 100) liveHistory.shift(); if (feedMode === 'live') chatView.add(m); },
    onDelete: (id) => { liveHistory = liveHistory.filter((m) => m.id !== id); if (feedMode === 'live') chatView.remove(id); },
    onLog: onLiveLog,
  });
  setFeed('demo');
  showPage(location.hash.slice(1) || 'overview');
  autoSyncKick();
  setInterval(() => autoSyncKick({ force: true }), 10 * 60_000); // keep the follower total fresh while the dashboard is open
}
boot().catch((e) => toast(e.message, 'err'));

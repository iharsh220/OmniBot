import { DEFAULTS, THEMES, FONTS, applyRoot, normalizeSettings } from './settings.js';
import { ChatView, StatsView, createMessageEl, ICONS } from './render.js';
import { connectLive, startDemo } from './feed.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ── tiny helpers ───────────────────────────────────────────────────────
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v; // only used with our own static icons
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { location.href = '/login'; throw new Error('Logged out'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), err ? 5000 : 1800);
}
const fmtN = (x) => (x === null || x === undefined ? '—' : Number(x).toLocaleString('en-US'));
const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ── State ──────────────────────────────────────────────────────────────
let me = null;
let widgets = [];
let current = null; // widget object
let settings = { ...DEFAULTS };
let feedMode = 'demo';
let liveState = null;
let liveHistory = [];
let demo = null;
let page = 'studio';

// ── Control schema ─────────────────────────────────────────────────────
const SECTIONS = [
  {
    title: '🎨 Colors & background', types: ['chat', 'stats'], fields: [
      { k: 'textColor', t: 'color', label: 'Text' },
      { k: 'msgBg', t: 'color', label: 'Message background' },
      { k: 'msgBgOpacity', t: 'range', label: 'Message opacity', min: 0, max: 100, unit: '%' },
      { k: 'accent', t: 'color', label: 'Accent' },
      { k: 'nameColor', t: 'seg', label: 'Username color', types: ['chat'], options: [['user', 'User'], ['platform', 'Platform'], ['accent', 'Accent'], ['custom', 'Custom']] },
      { k: 'nameColorCustom', t: 'color', label: 'Custom name color', types: ['chat'], show: (s) => s.nameColor === 'custom' },
      { k: 'pageBg', t: 'color', label: 'Widget background' },
      { k: 'pageBgOpacity', t: 'range', label: 'Widget bg opacity', min: 0, max: 100, unit: '%', fmt: (v) => (v === 0 ? 'Transparent' : `${v}%`) },
      { t: 'quick' },
    ],
  },
  {
    title: '🔤 Typography & shape', types: ['chat', 'stats'], fields: [
      { k: 'font', t: 'select', label: 'Font', options: Object.keys(FONTS).map((f) => [f, f]) },
      { k: 'fontSize', t: 'range', label: 'Font size', min: 10, max: 40, unit: 'px' },
      { k: 'fontWeight', t: 'select', label: 'Weight', num: true, options: [[400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold']] },
      { k: 'radius', t: 'range', label: 'Corner radius', min: 0, max: 30, unit: 'px' },
      { k: 'padding', t: 'range', label: 'Padding', min: 2, max: 24, unit: 'px' },
      { k: 'gap', t: 'range', label: 'Spacing', min: 0, max: 24, unit: 'px' },
      { k: 'shadow', t: 'toggle', label: 'Shadow' },
      { k: 'stroke', t: 'toggle', label: 'Text outline' },
    ],
  },
  {
    title: '💬 Message content', types: ['chat'], fields: [
      { k: 'showAvatar', t: 'toggle', label: 'Avatar' },
      { k: 'showBadges', t: 'toggle', label: 'Badges (mod, sub…)' },
      { k: 'showPlatform', t: 'toggle', label: 'Platform icon' },
      { k: 'showTime', t: 'toggle', label: 'Timestamp' },
    ],
  },
  {
    title: '⚡ Behaviour', types: ['chat'], fields: [
      { k: 'animation', t: 'seg', label: 'Animation', options: [['slide', 'Slide'], ['fade', 'Fade'], ['pop', 'Pop'], ['none', 'None']] },
      { k: 'direction', t: 'seg', label: 'New messages', options: [['bottom', 'At bottom'], ['top', 'At top']] },
      { k: 'hideAfter', t: 'range', label: 'Hide after', min: 0, max: 120, fmt: (v) => (v === 0 ? 'Never' : `${v}s`) },
      { k: 'maxMessages', t: 'range', label: 'Max messages', min: 3, max: 100 },
    ],
  },
  {
    title: '🧹 Sources & filters', types: ['chat'], fields: [
      { k: 'youtube', t: 'toggle', label: 'YouTube chat' },
      { k: 'kick', t: 'toggle', label: 'Kick chat' },
      { k: 'hideCommands', t: 'toggle', label: 'Hide !commands' },
      { k: 'hideBots', t: 'text', label: 'Hide users', placeholder: 'nightbot, botrix' },
    ],
  },
  {
    title: '📊 Stats content', types: ['stats'], fields: [
      { k: 'statsLayout', t: 'seg', label: 'Layout', options: [['row', 'Row'], ['column', 'Column'], ['pill', 'Pill']] },
      { k: 'statsYoutube', t: 'toggle', label: 'YouTube' },
      { k: 'statsKick', t: 'toggle', label: 'Kick' },
      { k: 'statsViewers', t: 'toggle', label: 'Live viewers' },
      { k: 'statsSubs', t: 'toggle', label: 'Subs / followers' },
      { k: 'statsTotal', t: 'toggle', label: 'Total viewers card' },
      { k: 'statsLabels', t: 'toggle', label: 'Labels' },
      { k: 'statsCompact', t: 'toggle', label: 'Compact (15.3K)' },
      { k: 'statsHideOffline', t: 'toggle', label: 'Hide when offline' },
    ],
  },
];
const collapsed = new Set(['🧹 Sources & filters']);

// ── Saving (debounced autosave to SQLite via API) ──────────────────────
let saveTimer = null;
function saveState(text, cls = '') { const s = $('#save-state'); s.textContent = text; s.className = 'save-state ' + cls; }
function scheduleSave() {
  if (!current) return;
  saveState('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!current) return;
  try {
    const w = await api(`/api/widgets/${current.id}`, { method: 'PUT', body: JSON.stringify({ name: current.name, settings }) });
    Object.assign(current, w);
    saveState('Saved ✓', 'ok');
  } catch (e) {
    saveState('Save failed', 'err');
    toast(e.message, true);
  }
}

function set(k, v, { rebuild = false } = {}) {
  settings[k] = v;
  scheduleSave();
  refreshPreview();
  if (rebuild) renderControls();
}

// ── Controls ───────────────────────────────────────────────────────────
function control(f) {
  const v = settings[f.k];
  switch (f.t) {
    case 'color': {
      const text = h('input', { type: 'text', value: v, maxlength: 7 });
      const pick = h('input', { type: 'color', value: v });
      pick.addEventListener('input', () => { text.value = pick.value; set(f.k, pick.value); });
      text.addEventListener('change', () => {
        const c = text.value.startsWith('#') ? text.value : '#' + text.value;
        if (/^#[0-9a-f]{6}$/i.test(c)) { pick.value = c.toLowerCase(); set(f.k, c.toLowerCase()); } else text.value = settings[f.k];
      });
      return h('div', { class: 'color' }, pick, text);
    }
    case 'range': {
      const label = (n) => (f.fmt ? f.fmt(n) : `${n}${f.unit || ''}`);
      const out = h('span', { class: 'val' }, label(v));
      const r = h('input', { type: 'range', min: f.min, max: f.max, step: f.step || 1, value: v });
      r.addEventListener('input', () => { out.textContent = label(Number(r.value)); set(f.k, Number(r.value)); });
      return [r, out];
    }
    case 'toggle': {
      const i = h('input', { type: 'checkbox' });
      i.checked = !!v;
      i.addEventListener('change', () => set(f.k, i.checked));
      return h('label', { class: 'switch' }, i, h('span'));
    }
    case 'select': {
      const sel = h('select', {}, f.options.map(([val, label]) => {
        const o = h('option', { value: val }, label);
        if (String(val) === String(v)) o.selected = true;
        return o;
      }));
      sel.addEventListener('change', () => set(f.k, f.num ? Number(sel.value) : sel.value));
      return sel;
    }
    case 'seg':
      return h('div', { class: 'segctl' }, f.options.map(([val, label]) =>
        h('button', { type: 'button', class: val === v ? 'on' : '', onclick: () => set(f.k, val, { rebuild: true }) }, label)));
    case 'text': {
      const i = h('input', { type: 'text', value: v, placeholder: f.placeholder || '' });
      i.addEventListener('input', () => set(f.k, i.value));
      return i;
    }
    default:
      return null;
  }
}

function renderControls() {
  const root = $('#controls');
  root.replaceChildren();
  const type = current?.type || 'chat';
  for (const sec of SECTIONS) {
    if (!sec.types.includes(type)) continue;
    const body = h('div', { class: 'block-body' });
    for (const f of sec.fields) {
      if (f.types && !f.types.includes(type)) continue;
      if (f.show && !f.show(settings)) continue;
      if (f.t === 'quick') {
        body.append(h('div', { class: 'row note' }, h('div', { class: 'picker-row', style: 'margin:4px 0 0' },
          h('button', { type: 'button', class: 'btn small', onclick: () => { settings.pageBgOpacity = 0; settings.msgBgOpacity = 0; settings.stroke = true; scheduleSave(); refreshPreview(); renderControls(); } }, '✨ Fully transparent'),
          h('button', { type: 'button', class: 'btn small', onclick: () => { settings.pageBgOpacity = 0; scheduleSave(); refreshPreview(); renderControls(); } }, 'Transparent widget bg'))));
        continue;
      }
      body.append(h('div', { class: 'row' }, h('label', {}, f.label), h('div', { class: 'ctl' }, control(f))));
    }
    const block = h('section', { class: 'block' + (collapsed.has(sec.title) ? ' collapsed' : '') });
    const title = h('div', { class: 'block-title' }, sec.title);
    title.addEventListener('click', () => {
      block.classList.toggle('collapsed');
      block.classList.contains('collapsed') ? collapsed.add(sec.title) : collapsed.delete(sec.title);
    });
    block.append(title, body);
    root.append(block);
  }
}

// ── Theme gallery ──────────────────────────────────────────────────────
const SAMPLE = {
  id: 'sample', platform: 'youtube', kind: 'chat', ts: Date.now(),
  author: { name: 'PixelPanda', avatar: null, color: null, badges: [{ type: 'moderator', label: 'Moderator' }] },
  parts: [{ type: 'text', text: 'This overlay looks clean 🔥' }],
};
const LOOK_KEYS = ['font', 'fontSize', 'fontWeight', 'textColor', 'msgBg', 'msgBgOpacity', 'accent', 'nameColor', 'radius', 'showAvatar', 'stroke'];

function renderThemes() {
  const grid = $('#themes');
  grid.replaceChildren();
  for (const t of THEMES) {
    const s = { ...DEFAULTS, ...t.values, theme: t.id, fontSize: 11, padding: 7, pageBgOpacity: 0 };
    const mini = document.createElement('div');
    applyRoot(mini, s, 'chat');
    mini.append(createMessageEl(SAMPLE, s));
    grid.append(h('button', {
      type: 'button', class: 'theme-card' + (settings.theme === t.id ? ' active' : ''), title: t.desc,
      onclick: () => {
        for (const k of LOOK_KEYS) settings[k] = k in t.values ? t.values[k] : DEFAULTS[k];
        settings.theme = t.id;
        scheduleSave();
        renderThemes();
        renderControls();
        refreshPreview();
      },
    }, h('div', { class: 'tc-preview' }, mini), h('div', { class: 'tc-meta' }, h('b', {}, t.name), h('span', {}, t.desc))));
  }
}

// ── Widgets ────────────────────────────────────────────────────────────
function renderWidgetPicker() {
  const sel = $('#widget-select');
  sel.replaceChildren(...widgets.map((w) => {
    const o = h('option', { value: w.id }, `${w.type === 'chat' ? '💬' : '📊'} ${w.name}`);
    if (w.id === current?.id) o.selected = true;
    return o;
  }));
  $('#widget-name').value = current?.name || '';
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
  renderThemes();
  renderControls();
  refreshPreview();
}

async function createWidget(type) {
  try {
    const base = current ? { ...settings } : {};
    const w = await api('/api/widgets', { method: 'POST', body: JSON.stringify({ type, name: `${type === 'chat' ? 'Chat' : 'Stats'} ${widgets.filter((x) => x.type === type).length + 1}`, settings: base }) });
    widgets.push(w);
    selectWidget(w.id);
    toast('Widget created');
  } catch (e) { toast(e.message, true); }
}

// ── Preview ────────────────────────────────────────────────────────────
const chatView = new ChatView($('#chat-preview'), settings);
const statsView = new StatsView($('#stats-preview'), settings);

function refreshPreview() {
  chatView.setSettings({ ...settings });
  statsView.setSettings({ ...settings });
  if (feedMode === 'live') statsView.setState(liveState || {});
  const url = current ? `${location.origin}/w/${current.id}` : '';
  $('#url').value = url;
  $('#open').href = url || '#';
  $('#url-label').textContent = current ? `${current.type === 'chat' ? 'Chat' : 'Stats'} widget URL — “${current.name}”` : 'Widget URL';
  $('#size-hint').textContent = current?.type === 'stats' ? (settings.statsLayout === 'column' ? '320 × 300' : '800 × 140') : '400 × 700';
}

function setFeed(mode) {
  feedMode = mode;
  demo?.stop();
  demo = null;
  chatView.clear();
  if (mode === 'demo') {
    demo = startDemo({ onChat: (m) => chatView.add(m), onState: (st) => statsView.setState(st), platforms: () => ['youtube', 'kick'].filter((p) => settings[p]) });
  } else {
    chatView.setHistory(liveHistory);
    statsView.setState(liveState || {});
  }
  $$('#feed-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
}

// ── Status chips + connections ─────────────────────────────────────────
function chip(id, cls, text, title = '') {
  const c = $(id);
  c.className = 'chip ' + cls;
  c.querySelector('span').textContent = text;
  c.title = title;
}
function renderStatus() {
  const st = liveState;
  if (!st) return;
  const yt = st.youtube;
  if (!yt.connected) chip('#chip-youtube', '', 'YouTube: not connected');
  else if (yt.live) chip('#chip-youtube', 'live', `YouTube LIVE · ${fmtN(yt.viewers)}`, yt.title || '');
  else chip('#chip-youtube', yt.error ? 'warn' : 'ok', `YouTube · ${fmtN(yt.subscribers)} subs`, yt.error || 'Offline');
  const k = st.kick;
  if (!k.connected) chip('#chip-kick', '', 'Kick: not connected');
  else if (k.live) chip('#chip-kick', 'live', `Kick LIVE · ${fmtN(k.viewers)}`, k.title || '');
  else chip('#chip-kick', k.error ? 'warn' : 'ok', k.followers != null ? `Kick · ${fmtN(k.followers)} followers` : `Kick · ${fmtN(k.subscribers)} subs`, k.error || 'Offline');
  if (page === 'connections') renderConnections();
}

const PLATFORM_INFO = {
  youtube: { name: 'YouTube', subs: 'Subscribers', key: 'subscribers', env: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET' },
  kick: { name: 'Kick', subs: 'Subscribers', key: 'subscribers', env: 'KICK_CLIENT_ID / KICK_CLIENT_SECRET' },
};
function renderConnections() {
  const grid = $('#conn-grid');
  grid.replaceChildren();
  for (const p of ['youtube', 'kick']) {
    const info = PLATFORM_INFO[p];
    const acc = me.accounts.find((a) => a.provider === p);
    const st = liveState?.[p] || {};
    const configured = me.providers[p];
    const card = h('div', { class: `card conn ${p}` });
    card.append(h('div', { class: 'conn-head' },
      h('div', { class: 'conn-logo', html: ICONS[p] }),
      h('div', {}, h('b', {}, info.name), h('span', { class: 'muted tiny' }, acc ? 'Connected' : 'Not connected')),
      h('div', { style: 'margin-left:auto' }, acc ? h('span', { class: 'pill ' + (st.live ? 'live' : 'ok') }, st.live ? '● LIVE' : 'Connected') : null)));
    if (acc) {
      card.append(h('div', { class: 'conn-acc' },
        acc.avatar ? h('img', { src: acc.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'ph' }),
        h('div', { class: 'meta' }, h('b', {}, acc.channelName || '—'), h('span', { class: 'muted tiny' }, p === 'kick' ? `kick.com/${acc.channelSlug}` : acc.channelSlug || acc.channelId))));
      card.append(h('div', { class: 'conn-stats' },
        h('div', {}, h('span', {}, 'Status'), h('b', {}, st.live ? 'Live' : 'Offline')),
        h('div', {}, h('span', {}, 'Viewers'), h('b', {}, st.live ? fmtN(st.viewers) : '—')),
        h('div', {}, h('span', {}, info.subs), h('b', {}, fmtN(st[info.key])))));
      if (p === 'kick' && st.followers != null) card.querySelector('.conn-stats').append(h('div', {}, h('span', {}, 'Followers'), h('b', {}, fmtN(st.followers))));
      if (st.error) card.append(h('div', { class: 'conn-err' }, `⚠ ${st.error}`));
      if (p === 'kick') card.append(kickChatBox(acc, st));
      card.append(h('div', { class: 'conn-actions' },
        h('a', { class: 'btn small', href: `/auth/${p}` }, '↻ Reconnect'),
        st.url ? h('a', { class: 'btn small ghost', href: st.url, target: '_blank', rel: 'noopener' }, 'Open channel ↗') : null,
        h('button', { class: 'btn small ghost danger', onclick: () => disconnect(p) }, 'Disconnect')));
    } else if (configured) {
      card.append(h('p', { class: 'muted' }, `Connect ${info.name} to show its chat and stats in your widgets.`));
      card.append(h('a', { class: 'btn primary', href: `/auth/${p}` }, `Connect ${info.name}`));
    } else {
      card.append(h('p', { class: 'muted' }, `${info.name} login is not configured on this server. The admin must set ${info.env} in .env.`));
    }
    grid.append(card);
  }
}
/** Pull ids + followers out of a pasted kick.com/api/v2/channels/<slug> page (or a bare chatroom id). */
function parseKickPaste(text) {
  const t = String(text || '').trim();
  if (/^\d+$/.test(t)) return { chatroomId: t };
  let j = null;
  try { j = JSON.parse(t); } catch { /* not clean JSON — fall back to regex */ }
  const pick = (re) => (t.match(re) || [])[1];
  return {
    chatroomId: j?.chatroom?.id ?? pick(/"chatroom"\s*:\s*\{\s*"id"\s*:\s*(\d+)/),
    channelId: j?.id ?? pick(/^\s*\{\s*"id"\s*:\s*(\d+)/),
    followers: j?.followers_count ?? pick(/"followers_count"\s*:\s*(\d+)/),
  };
}

function kickChatBox(acc, st) {
  const box = h('div', { class: 'chatroom-box' });
  // Chat status
  if (st.chatMode === 'webhook') box.append(h('p', { class: 'ok-line' }, '✅ Chat: automatic via official Kick webhooks'));
  else if (st.chatMode === 'pusher' && st.chatConnected) box.append(h('p', { class: 'ok-line' }, `✅ Chat connected (chatroom ${acc.chatroomId ?? 'auto'})`));
  else box.append(h('p', { class: 'muted tiny' }, 'Chat turns on automatically when OmniChat runs on a public https URL with Kick webhooks enabled. Locally, use the sync below.'));

  // Followers status
  const followersKnown = st.followers != null;
  box.append(h('p', { class: followersKnown ? 'ok-line' : 'muted tiny', style: 'margin-top:6px' },
    followersKnown
      ? `✅ Followers: ${fmtN(st.followers)}${acc.kickChannelId ? ' · updates live' : ''}`
      : 'Followers: Kick’s official API does not share the follower total. Sync it once below — after that it updates live.'));

  const needsSync = !followersKnown || !acc.kickChannelId || (st.chatMode !== 'webhook' && !acc.chatroomId);
  const input = h('textarea', { rows: 3, placeholder: 'Paste the whole page here (Cmd/Ctrl+A → Cmd/Ctrl+C on the link above)' });
  const save = h('button', { class: 'btn small primary', type: 'button' }, 'Sync from Kick');
  save.addEventListener('click', async () => {
    const data = parseKickPaste(input.value);
    if (!data.chatroomId && !data.channelId && !data.followers) return toast('Could not find Kick data in what you pasted', true);
    try {
      const r = await api('/api/accounts/kick/sync', { method: 'PUT', body: JSON.stringify(data) });
      Object.assign(acc, r.account);
      input.value = '';
      toast(`Synced ✓ ${data.followers ? `· ${fmtN(Number(data.followers))} followers` : ''}`);
    } catch (e) { toast(e.message, true); }
  });
  const link = `https://kick.com/api/v2/channels/${encodeURIComponent(acc.channelSlug || '')}`;
  box.append(h('details', { class: 'manual', open: needsSync ? true : undefined },
    h('summary', {}, needsSync ? 'One-time sync (followers + chat)' : 'Re-sync from Kick'),
    h('ol', { class: 'tiny muted sync-steps' },
      h('li', {}, 'Open ', h('a', { href: link, target: '_blank', rel: 'noopener' }, 'your Kick channel data'), ' (opens in a new tab)'),
      h('li', {}, 'Press Cmd/Ctrl + A, then Cmd/Ctrl + C'),
      h('li', {}, 'Paste below and click Sync')),
    input, h('div', { style: 'margin-top:8px' }, save)));
  return box;
}

async function disconnect(p) {
  if (!confirm(`Disconnect ${PLATFORM_INFO[p].name}?`)) return;
  try {
    await api(`/api/accounts/${p}`, { method: 'DELETE' });
    me.accounts = me.accounts.filter((a) => a.provider !== p);
    renderConnections();
    toast('Disconnected');
  } catch (e) { toast(e.message, true); }
}

// ── Logs page ──────────────────────────────────────────────────────────
let logsTab = 'system';
function setTable(head, rows) {
  $('#logs-table thead').replaceChildren(h('tr', {}, head.map((x) => h('th', {}, x))));
  $('#logs-table tbody').replaceChildren(...rows);
  $('#logs-empty').hidden = rows.length > 0;
}
function logRow(l, isNew = false) {
  return h('tr', { class: isNew ? 'new' : '' },
    h('td', { class: 'ts' }, fmtTime(l.ts)),
    h('td', {}, h('span', { class: `lvl ${l.level}` }, l.level)),
    h('td', {}, h('span', { class: 'src' }, l.source)),
    h('td', { class: 'msg-cell' }, l.message));
}
async function loadLogs() {
  if (logsTab === 'system') {
    const level = $('#log-level').value;
    const rows = await api(`/api/logs?limit=300${level ? '&level=' + level : ''}`);
    setTable(['Time', 'Level', 'Source', 'Message'], rows.map((l) => logRow(l)));
  } else {
    const q = $('#chat-q').value.trim();
    const pf = $('#chat-platform').value;
    const r = await api(`/api/messages?limit=300&q=${encodeURIComponent(q)}${pf ? '&platform=' + pf : ''}`);
    setTable(['Time', 'Platform', 'User', 'Message'], r.rows.map((m) => h('tr', { class: m.deleted ? 'del' : '' },
      h('td', { class: 'ts' }, fmtTime(m.ts)),
      h('td', {}, h('span', { class: 'plat-ic', html: ICONS[m.platform] || '' })),
      h('td', {}, h('b', {}, m.author)),
      h('td', { class: 'msg-cell' }, (m.kind !== 'chat' ? `[${m.kind}] ` : '') + (m.text || '')))));
    const counts = Object.fromEntries(r.last24h.map((x) => [x.platform, x.n]));
    $('#chat-count').textContent = `Last 24h: ${fmtN(counts.youtube || 0)} YouTube · ${fmtN(counts.kick || 0)} Kick`;
  }
}
function onLiveLog(l) {
  if (page !== 'logs' || logsTab !== 'system') return;
  const lvl = $('#log-level').value;
  if (lvl && l.level !== lvl) return;
  $('#logs-table tbody').prepend(logRow(l, true));
  $('#logs-empty').hidden = true;
}

// ── Routing ────────────────────────────────────────────────────────────
function showPage(p) {
  page = ['studio', 'connections', 'logs'].includes(p) ? p : 'studio';
  for (const id of ['studio', 'connections', 'logs']) $(`#page-${id}`).hidden = id !== page;
  $$('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === page));
  if (page === 'connections') renderConnections();
  if (page === 'logs') loadLogs().catch((e) => toast(e.message, true));
}
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));

// ── Wiring ─────────────────────────────────────────────────────────────
$('#widget-select').addEventListener('change', (e) => selectWidget(e.target.value));
$('#widget-name').addEventListener('input', (e) => {
  if (!current) return;
  current.name = e.target.value || current.name;
  scheduleSave();
  clearTimeout(renderWidgetPicker.t);
  renderWidgetPicker.t = setTimeout(() => { renderWidgetPicker(); refreshPreview(); }, 400);
});
$('#new-chat').addEventListener('click', () => createWidget('chat'));
$('#new-stats').addEventListener('click', () => createWidget('stats'));
$('#delete-widget').addEventListener('click', async () => {
  if (!current) return;
  if (widgets.length <= 1) return toast('Keep at least one widget', true);
  if (!confirm(`Delete “${current.name}”? Its URL will stop working.`)) return;
  try {
    await api(`/api/widgets/${current.id}`, { method: 'DELETE' });
    widgets = widgets.filter((w) => w.id !== current.id);
    current = null;
    selectWidget(widgets[0].id);
    toast('Widget deleted');
  } catch (e) { toast(e.message, true); }
});
$$('#feed-mode button').forEach((b) => b.addEventListener('click', () => setFeed(b.dataset.v)));
$$('#backdrop button').forEach((b) => b.addEventListener('click', () => {
  $('#stage').className = 'stage bd-' + b.dataset.v;
  $$('#backdrop button').forEach((x) => x.classList.toggle('on', x === b));
}));
$('#clear').addEventListener('click', () => chatView.clear());
$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#url').value); } catch { $('#url').select(); document.execCommand('copy'); }
  toast('URL copied ✓');
});
$('#url').addEventListener('focus', (e) => e.target.select());
$('#reset').addEventListener('click', () => {
  if (!confirm('Reset this widget to default settings?')) return;
  settings = { ...DEFAULTS };
  scheduleSave();
  renderThemes();
  renderControls();
  refreshPreview();
});
$('#logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/login';
});
$('#restart').addEventListener('click', async () => {
  try { await api('/api/watchers/restart', { method: 'POST' }); toast('Watchers restarted'); } catch (e) { toast(e.message, true); }
});
$$('#logs-tab button').forEach((b) => b.addEventListener('click', () => {
  logsTab = b.dataset.v;
  $$('#logs-tab button').forEach((x) => x.classList.toggle('on', x === b));
  $('#tools-system').hidden = logsTab !== 'system';
  $('#tools-chat').hidden = logsTab !== 'chat';
  loadLogs().catch((e) => toast(e.message, true));
}));
$('#log-level').addEventListener('change', () => loadLogs());
$('#logs-refresh').addEventListener('click', () => loadLogs());
$('#logs-clear').addEventListener('click', async () => {
  if (!confirm('Delete all your system logs?')) return;
  await api('/api/logs', { method: 'DELETE' });
  loadLogs();
});
let qTimer;
$('#chat-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadLogs, 300); });
$('#chat-platform').addEventListener('change', () => loadLogs());
window.addEventListener('beforeunload', () => { if (saveTimer) saveNow(); });

// ── Boot ───────────────────────────────────────────────────────────────
async function boot() {
  me = await api('/api/me');
  widgets = me.widgets;
  $('#user-name').textContent = me.user.name || 'Streamer';
  const av = $('#user-av');
  if (me.user.avatar) av.append(h('img', { src: me.user.avatar, alt: '', referrerpolicy: 'no-referrer' }));
  else av.textContent = (me.user.name || '?')[0].toUpperCase();

  let last = null;
  try { last = localStorage.getItem('omnichat.widget'); } catch { /* ignore */ }
  selectWidget(widgets.some((w) => w.id === last) ? last : widgets[0]?.id);

  const params = new URLSearchParams(location.search);
  if (params.get('error')) { toast(params.get('error'), true); history.replaceState(null, '', '/' + location.hash); }

  connectLive('/api/events', {
    onStatus: (ok) => chip('#chip-server', ok ? 'ok' : 'bad', ok ? 'Server' : 'Server offline'),
    onState: (st) => { liveState = st; renderStatus(); if (feedMode === 'live') statsView.setState(st); },
    onHistory: (list) => { liveHistory = list; if (feedMode === 'live') chatView.setHistory(list); },
    onChat: (m) => { liveHistory.push(m); if (liveHistory.length > 100) liveHistory.shift(); if (feedMode === 'live') chatView.add(m); },
    onDelete: (id) => { liveHistory = liveHistory.filter((m) => m.id !== id); if (feedMode === 'live') chatView.remove(id); },
    onLog: onLiveLog,
  });
  setFeed('demo');
  showPage(location.hash.slice(1));
}
boot().catch((e) => toast(e.message, true));

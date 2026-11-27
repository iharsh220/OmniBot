// DOM rendering for chat messages and stats. Uses textContent for all user text (XSS-safe).
import { PLATFORM_COLORS, applyRoot } from './settings.js';

export const ICONS = {
  youtube: '<svg viewBox="0 0 24 24"><rect x="1" y="4.5" width="22" height="15" rx="4.5" fill="#ff0033"/><path d="M10 9v6l5.2-3z" fill="#fff"/></svg>',
  kick: '<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#53fc18"/><path d="M6 5h4v4h2V7h2V5h4v6h-2v2h2v6h-4v-2h-2v-2h-2v4H6z" fill="#0b0b0b"/></svg>',
  broadcaster: '<svg viewBox="0 0 24 24"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5z" fill="currentColor"/></svg>',
  moderator: '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5z" fill="currentColor"/></svg>',
  member: '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" fill="currentColor"/></svg>',
  verified: '<svg viewBox="0 0 24 24"><path d="M12 1.5l2.6 2 3.3-.3 1 3.1 2.7 1.9-1 3.2 1 3.1-2.7 1.9-1 3.1-3.3-.3-2.6 2-2.6-2-3.3.3-1-3.1-2.7-1.9 1-3.1-1-3.2 2.7-1.9 1-3.1 3.3.3z" fill="currentColor"/><path d="M8 12.2l2.7 2.6L16.3 9" stroke="#000" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
  vip: '<svg viewBox="0 0 24 24"><path d="M6 3h12l4 6-10 12L2 9z" fill="currentColor"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M12 5C6.5 5 2.7 9.2 1.5 12c1.2 2.8 5 7 10.5 7s9.3-4.2 10.5-7C21.3 9.2 17.5 5 12 5zm0 11a4 4 0 110-8 4 4 0 010 8z" fill="currentColor"/></svg>',
  users: '<svg viewBox="0 0 24 24"><path d="M9 11a4 4 0 100-8 4 4 0 000 8zm7.5 0a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM1 20c0-3.9 3.6-6.5 8-6.5s8 2.6 8 6.5v1H1zm16.4-6.4c3.3.3 5.6 2.5 5.6 5.4v2h-4.5v-1c0-2.6-.4-4.8-1.1-6.4z" fill="currentColor"/></svg>',
};
ICONS.og = ICONS.vip;
ICONS.founder = ICONS.member;
ICONS.subscriber = ICONS.member;
ICONS.sub_gifter = '<svg viewBox="0 0 24 24"><path d="M3 9h18v4H3zm1 5h7v8H4zm9 0h7v8h-7zM12 9c-1-3-3.5-5.5-5.5-4.2S7 9 12 9zm0 0c1-3 3.5-5.5 5.5-4.2S17 9 12 9z" fill="currentColor"/></svg>';
ICONS.staff = ICONS.verified;

const BADGE_COLORS = {
  broadcaster: '#ff4757', moderator: '#2ed573', member: '#1e90ff', verified: '#a4b0be', vip: '#ff6bcb',
  og: '#ffa502', founder: '#ffd32a', subscriber: '#7bed9f', sub_gifter: '#eccc68', staff: '#70a1ff',
};

export function hashColor(name = '') {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 85% 66%)`;
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
};

function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; }
}

function nameColorFor(m, s) {
  switch (s.nameColor) {
    case 'platform': return PLATFORM_COLORS[m.platform];
    case 'accent': return 'var(--accent)';
    case 'custom': return s.nameColorCustom;
    default: return m.author.color || hashColor(m.author.name);
  }
}

export function createMessageEl(m, s) {
  const root = el('div', `msg plat-${m.platform} kind-${m.kind || 'chat'}`);
  root.style.setProperty('--name', nameColorFor(m, s));
  root.dataset.id = m.id;

  if (s.showAvatar) {
    const av = el('div', 'msg-avatar');
    const src = m.author.avatar && safeUrl(m.author.avatar);
    if (src) {
      const img = el('img');
      img.src = src; img.alt = ''; img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); av.textContent = (m.author.name || '?')[0].toUpperCase(); };
      av.append(img);
    } else {
      av.textContent = (m.author.name || '?')[0].toUpperCase();
    }
    root.append(av);
  }

  const body = el('div', 'msg-body');
  const head = el('div', 'msg-head');
  if (s.showPlatform) {
    const p = el('span', 'msg-platform');
    p.innerHTML = ICONS[m.platform] || '';
    p.title = m.platform;
    head.append(p);
  }
  if (s.showBadges) {
    for (const b of m.author.badges || []) {
      const badge = el('span', `msg-badge badge-${b.type}`);
      badge.title = b.label || b.type;
      const img = b.img && safeUrl(b.img);
      if (img) { const i = el('img'); i.src = img; i.alt = ''; badge.append(i); }
      else if (ICONS[b.type]) { badge.innerHTML = ICONS[b.type]; badge.style.color = BADGE_COLORS[b.type] || '#ccc'; }
      else continue;
      head.append(badge);
    }
  }
  head.append(el('span', 'msg-name', m.author.name));
  if (s.showTime) {
    const d = new Date(m.ts || Date.now());
    head.append(el('span', 'msg-time', d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: s.timeFormat === '12h' })));
  }
  body.append(head);

  if (m.kind && m.kind !== 'chat') {
    const ev = el('div', 'msg-event');
    if (m.amount) ev.append(el('span', 'msg-amount', m.amount));
    if (m.eventText) ev.append(el('span', 'msg-event-text', m.eventText));
    body.append(ev);
  }

  if (m.parts?.length) {
    const text = el('div', 'msg-text');
    if (m.replyTo) text.append(el('span', 'msg-reply', `@${m.replyTo} `));
    let budget = s.maxLength > 0 ? s.maxLength : Infinity; // "Shorten long messages"
    for (const part of m.parts) {
      if (budget <= 0) { text.append(document.createTextNode('…')); break; }
      if (part.type === 'emote') {
        budget -= 1;
        const src = safeUrl(part.url);
        if (!src) { text.append(document.createTextNode(part.name || '')); continue; }
        const img = el('img', 'msg-emote');
        img.src = src; img.alt = part.name || ''; img.title = part.name || '';
        text.append(img);
      } else {
        let t = part.text || '';
        if (t.length > budget) { t = t.slice(0, Math.max(0, budget)).trimEnd() + '…'; budget = 0; } else budget -= t.length;
        text.append(document.createTextNode(t));
        if (budget === 0 && t.endsWith('…')) break;
      }
    }
    body.append(text);
  }
  root.append(body);
  return root;
}

// ── Chat view ─────────────────────────────────────────────────────────
export class ChatView {
  constructor(root, settings) {
    this.root = root;
    this.list = el('div', 'chat-list');
    root.append(this.list);
    this.messages = [];
    this.setSettings(settings);
  }

  setSettings(s) {
    this.s = s;
    this.bots = new Set(String(s.hideBots || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
    this.blocked = String(s.blockedWords || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    applyRoot(this.root, s, 'chat');
    this.rerender();
  }

  passes(m) {
    const s = this.s;
    if (m.kind === 'highlight' || m.kind === 'highlight-clear') return false; // shown by the Alerts widget
    if (s[m.platform] === false) return false;
    if (this.bots.has((m.author?.name || '').toLowerCase())) return false;
    if (s.hideCommands && (m.parts?.[0]?.text || '').trim().startsWith('!')) return false;
    if (s.hideAfter > 0 && m.history) return false;
    if (s.hideAfter > 0 && m.arrivedAt && Date.now() - m.arrivedAt > s.hideAfter * 1000) return false;
    if (!s.showEvents && m.kind && m.kind !== 'chat') return false;
    if (m.kind === 'chat' || !m.kind) {
      const text = (m.parts || []).map((p) => (p.type === 'emote' ? '' : p.text || '')).join('').trim();
      const emotes = (m.parts || []).filter((p) => p.type === 'emote').length;
      if (s.hideLinks && /(https?:\/\/|www\.)\S+|\b\S+\.(com|net|org|gg|io|in|tv|ly|me|xyz)\b/i.test(text)) return false;
      if (s.minLength > 0 && text.length + emotes < s.minLength) return false;
      if (this.blocked.length) {
        const low = text.toLowerCase();
        if (this.blocked.some((w) => low.includes(w))) return false;
      }
    }
    return true;
  }

  wrap(m, animate) {
    const w = el('div', 'msg-wrap' + (animate ? '' : ' no-anim'));
    w.dataset.id = m.id;
    if (this.s.hideAfter > 0) {
      const remaining = Math.max(0.1, this.s.hideAfter - (Date.now() - (m.arrivedAt || Date.now())) / 1000);
      w.classList.add('hides');
      w.style.setProperty('--hide', `${remaining}s`);
      setTimeout(() => w.remove(), (remaining + 0.8) * 1000);
    }
    w.append(createMessageEl(m, this.s));
    return w;
  }

  add(m, { history = false } = {}) {
    if (this.messages.some((x) => x.id === m.id)) return;
    const msg = { ...m, history, arrivedAt: history ? 0 : Date.now() };
    this.messages.push(msg);
    if (this.messages.length > 300) this.messages.splice(0, this.messages.length - 300);
    if (!this.passes(msg)) return;
    this.list.append(this.wrap(msg, !history));
    this.trim();
  }

  setHistory(list) {
    this.messages = [];
    for (const m of list) this.messages.push({ ...m, history: true, arrivedAt: 0 });
    this.rerender();
  }

  remove(id) {
    this.messages = this.messages.filter((m) => m.id !== id);
    this.list.querySelector(`.msg-wrap[data-id="${CSS.escape(id)}"]`)?.remove();
  }

  clear() {
    this.messages = [];
    this.list.replaceChildren();
  }

  trim() {
    const max = Math.max(1, this.s.maxMessages);
    while (this.list.children.length > max) this.list.firstElementChild.remove();
  }

  rerender() {
    const visible = this.messages.filter((m) => this.passes(m)).slice(-Math.max(1, this.s.maxMessages));
    this.list.replaceChildren(...visible.map((m) => this.wrap(m, false)));
  }
}

// ── Stats view ────────────────────────────────────────────────────────
function fmt(n, compact) {
  if (n === null || n === undefined) return '—';
  return compact
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : Math.round(n).toLocaleString('en-US');
}

function tween(node, to, compact) {
  const from = Number(node.dataset.value);
  node.dataset.value = to ?? '';
  if (to === null || to === undefined || Number.isNaN(from) || node.dataset.value === '' || from === to || compact) {
    node.textContent = fmt(to, compact);
    return;
  }
  const start = performance.now();
  const dur = 900;
  const step = (t) => {
    const p = Math.min(1, (t - start) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    node.textContent = fmt(from + (to - from) * e, false);
    if (p < 1 && node.dataset.value === String(to)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export class StatsView {
  constructor(root, settings) {
    this.root = root;
    this.state = null;
    this.setSettings(settings);
  }
  setSettings(s) {
    this.s = s;
    applyRoot(this.root, s, 'stats');
    this.build();
  }
  setState(state) {
    const before = this.items().map((i) => i.key).join();
    this.state = state;
    if (this.items().map((i) => i.key).join() !== before) this.build();
    else this.update();
  }
  items() {
    const s = this.s;
    const st = this.state || {};
    const out = [];
    if (s.statsYoutube && st.youtube?.connected !== false)
      out.push({ key: 'youtube', label: st.youtube?.channelName || 'YouTube', subsLabel: 'subscribers', d: st.youtube || {}, subs: st.youtube?.subscribers });
    if (s.statsKick && st.kick?.connected !== false)
      out.push({
        key: 'kick', label: st.kick?.channelName || 'Kick', d: st.kick || {},
        // Kick's official API has subscribers only; followers appear when available.
        subsLabel: st.kick?.followers != null ? 'followers' : 'subscribers',
        subs: st.kick?.followers ?? st.kick?.subscribers,
      });
    return out;
  }
  build() {
    const s = this.s;
    const box = el('div', 'stats-box');
    this.nodes = {};
    const icon = (name) => { const i = el('span', 'stat-i'); i.innerHTML = ICONS[name]; return i; };
    const item = (iconName, label) => {
      const v = el('div', 'stat-item');
      const num = el('span', 'stat-num', '—');
      if (s.statsIcons) v.append(icon(iconName));
      v.append(num);
      if (s.statsLabels && label) v.append(el('span', 'stat-sub', label));
      return { v, num };
    };
    for (const it of this.items()) {
      const card = el('div', `stat-card plat-${it.key}`);
      const head = el('div', 'stat-head');
      // card title: platform icon and/or channel name
      if (s.statsHeader === 'both' || s.statsHeader === 'icon') { const ic = el('span', 'stat-icon'); ic.innerHTML = ICONS[it.key]; head.append(ic); }
      const lbl = el('span', 'stat-label', it.label);
      if (s.statsHeader === 'both' || s.statsHeader === 'name') head.append(lbl);
      const live = el('span', 'stat-live', 'LIVE');
      if (s.statsLiveBadge) head.append(live);
      if (head.childNodes.length) card.append(head);
      const row = el('div', 'stat-row');
      let viewers, subs;
      if (s.statsViewers) { const x = item('eye', s.statsViewersText); viewers = x.num; row.append(x.v); }
      if (s.statsSubs) { const x = item('users', s.statsSubsText || it.subsLabel); subs = x.num; row.append(x.v); }
      card.append(row);
      box.append(card);
      this.nodes[it.key] = { card, viewers, subs, live, lbl };
    }
    if (s.statsTotal && s.statsViewers && this.items().length > 1) {
      const card = el('div', 'stat-card plat-total');
      if (s.statsHeader !== 'none' && s.statsTotalText) { const head = el('div', 'stat-head'); head.append(el('span', 'stat-label', s.statsTotalText)); card.append(head); }
      const row = el('div', 'stat-row');
      const x = item('eye', '');
      row.append(x.v);
      card.append(row);
      box.append(card);
      this.nodes.total = { card, viewers: x.num };
    }
    this.root.replaceChildren(box);
    this.update();
  }
  update() {
    if (!this.nodes) return;
    const s = this.s;
    let total = 0;
    let anyLive = false;
    for (const it of this.items()) {
      const n = this.nodes[it.key];
      if (!n) { this.build(); return; }
      const live = !!it.d.live;
      anyLive ||= live;
      if (live) total += it.d.viewers || 0;
      n.card.classList.toggle('is-live', live);
      n.card.classList.toggle('is-offline', !live);
      n.card.hidden = s.statsHideOffline && !live;
      if (n.lbl) n.lbl.textContent = it.label;
      if (n.viewers) {
        if (live) tween(n.viewers, it.d.viewers ?? 0, s.statsCompact);
        else { n.viewers.dataset.value = ''; n.viewers.textContent = 'Offline'; }
      }
      if (n.subs) tween(n.subs, it.subs ?? null, s.statsCompact);
    }
    if (this.nodes.total) {
      this.nodes.total.card.hidden = s.statsHideOffline && !anyLive;
      tween(this.nodes.total.viewers, total, s.statsCompact);
    }
  }
}

// ── Eggs view (Steal an Egg spawns overlay) ───────────────────────────
const RARITY_COLORS = {
  common: '#9ca3af', uncommon: '#4ade80', rare: '#60a5fa', epic: '#c084fc', legendary: '#f59e0b',
  mythic: '#f87171', secret: '#fb923c', eternal: '#a78bfa', divine: '#facc15',
};
const rarityColor = (r) => RARITY_COLORS[String(r || '').toLowerCase()] || 'var(--accent)';
export function eggAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** "1H 20M" style for the stock board. */
export function eggShort(ts) {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (m < 1) return 'NOW';
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}H ${m % 60}M` : `${h}H`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}D ${h % 24}H` : `${d}D`;
}
/** Egg picture from Discord (falls back to 🥚 when missing or broken). */
function eggIcon(e, cls) {
  const box = el('span', cls);
  const src = e.image && /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(e.image) ? e.image : null;
  if (!src) { box.textContent = '🥚'; return box; }
  const img = document.createElement('img');
  img.src = src; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
  img.onerror = () => { box.classList.remove('has-img'); box.textContent = '🥚'; };
  box.classList.add('has-img');
  box.append(img);
  return box;
}
const SPAWN_LIST = { divine: 5 }; // these rarities show their last N spawns (same egg can repeat)
/** Event icon: Discord picture if any, else its emoji. */
function eventIcon(ev, cls) {
  const box = el('span', cls);
  const fallback = ev.emoji || '✨';
  const src = ev.image && /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(ev.image) ? ev.image : null;
  if (!src) { box.textContent = fallback; return box; }
  const img = document.createElement('img');
  img.src = src; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
  img.onerror = () => { box.classList.remove('has-img'); box.textContent = fallback; };
  box.classList.add('has-img');
  box.append(img);
  return box;
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
const left = (ms) => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : null);

const RARITY_ORDER = ['secret', 'eternal', 'divine', 'mythic', 'legendary', 'epic', 'rare', 'uncommon', 'common'];

export class EggsView {
  constructor(root, settings) {
    this.root = root;
    this.items = [];
    this.events = []; // game events (Tidal Surge, Butterfly Bloom …), newest first
    this.lastSeen = []; // board: every egg name ever seen (server keeps it forever)
    this.seen = new Set();
    this.seenEv = new Set();
    this.first = true;
    this.firstEv = true;
    this.shownAt = new Map(); // id → when it first appeared on THIS overlay ("Hide after" counts from here)
    this.freshUntil = new Map(); // id → time until which it still plays its entry animation
    this.popUntil = 0; // popup mode: visible until
    this.preview = false; // Studio preview ignores popup mode (always visible)
    this.fit = false; // set by the OBS page (widget.js): fit everything into the window
    this.queue = []; // alert layout: new eggs/events waiting to be shown, oldest first
    this.current = null; // alert layout: the item on screen
    this.currentUntil = 0;
    this.setSettings(settings);
    this.timer = setInterval(() => this.refreshTimes(), 15_000);
  }
  setSettings(s) {
    this.s = s;
    applyRoot(this.root, s, 'eggs');
    this.render();
  }
  /** Newest first. Eggs not seen before get an entry animation (not on the first load). */
  setItems(items) {
    let n = 0;
    const added = [];
    for (const e of items || []) {
      if (!this.first && !this.seen.has(e.id)) { this.markFresh(e.id); this.markShown(e.id); n++; added.push({ type: 'egg', item: e }); }
      this.seen.add(e.id);
    }
    this.enqueue(added);
    this.first = false;
    this.items = items || [];
    if (n) this.popup();
    this.render();
  }
  /** Game events, newest first. New ones animate in (and open the popup). */
  setEvents(list) {
    let n = 0;
    const added = [];
    for (const ev of list || []) {
      if (!this.firstEv && !this.seenEv.has(ev.id)) { this.markFresh(ev.id); this.markShown(ev.id); n++; added.push({ type: 'event', item: ev }); }
      this.seenEv.add(ev.id);
    }
    if (this.s.eggsEvents !== false) this.enqueue(added);
    this.firstEv = false;
    this.events = Array.isArray(list) ? list : [];
    if (n && this.s.eggsEvents !== false) this.popup();
    this.render();
  }
  /** Alert layout: new things are shown one after another (oldest first), each for eggsPopup seconds. */
  enqueue(list) {
    if (!list.length) return;
    this.queue.push(...list.sort((a, b) => a.item.ts - b.item.ts));
    if (this.queue.length > 8) this.queue = this.queue.slice(-8); // a burst never queues for ages
    this.advance();
  }
  advance() {
    const sec = this.s.eggsPopup;
    if (this.current && sec > 0 && Date.now() < this.currentUntil) return;
    const next = this.queue.shift();
    if (next) {
      this.leaving = false;
      this.current = next;
      this.freshUntil.set(next.item.id, Date.now() + 2500);
      if (sec > 0) {
        this.currentUntil = Date.now() + sec * 1000;
        clearTimeout(this.alertTimer);
        this.alertTimer = setTimeout(() => { this.advance(); this.render(); }, sec * 1000 + 40);
      } else this.queue = []; // 0 = no timer: the newest one simply stays
    } else if (sec > 0 && this.current && Date.now() >= this.currentUntil && !this.leaving) {
      // nothing left → play the exit animation, then hide
      this.leaving = true;
      clearTimeout(this.alertTimer);
      this.alertTimer = setTimeout(() => { if (this.leaving) { this.current = null; this.leaving = false; this.render(); } }, 450);
    }
  }
  /** The newest egg or event (used when the alert has no timer, and in the Studio preview). */
  newest() {
    const e = this.items[0];
    const ev = this.s.eggsEvents !== false ? this.events[0] : null;
    if (!e && !ev) return null;
    return !ev || (e && e.ts >= ev.ts) ? { type: 'egg', item: e } : { type: 'event', item: ev };
  }
  alert(fresh) {
    const sec = this.s.eggsPopup;
    let cur = this.current;
    if (!cur && (sec <= 0 || this.preview)) cur = this.newest();
    if (sec <= 0 && this.current && this.newest()?.item.id !== this.current.item.id) cur = this.newest();
    if (!cur || (sec <= 0 && this.isHidden(cur.item))) return null;
    const box = el('div', 'eggs-box egg-alert' + (this.leaving && !this.preview ? ' leaving' : ''));
    if (cur.type === 'egg') box.append(this.hero(cur.item, fresh));
    else {
      const card = this.eventCard(cur.item, fresh, true);
      card.classList.add('egg-alert-ev');
      card.querySelector('.egg-evtop').dataset.tag = this.s.eggsEventLabel ?? '⚡ EVENT';
      box.append(card);
    }
    return box;
  }
  markShown(id) {
    this.shownAt.set(id, Date.now());
    if (this.shownAt.size > 400) this.shownAt.delete(this.shownAt.keys().next().value);
  }
  /** When "Hide after" removes it. Counted from when it appeared here: a spawn is noticed some seconds late, so 3 s after the spawn itself would be over already. */
  hideAt(x) { return this.s.eggsHideAfter > 0 ? Math.max(x.ts, this.shownAt.get(x.id) || 0) + this.s.eggsHideAfter * 1000 : Infinity; }
  isHidden(x) { return this.hideAt(x) <= Date.now(); }
  /** Redraw exactly when the next egg/event has to go. */
  scheduleHide() {
    clearTimeout(this.hideTimer);
    if (!(this.s.eggsHideAfter > 0)) return;
    const now = Date.now();
    let next = Infinity;
    for (const x of [...this.items, ...this.events, ...this.lastSeen]) { const t = this.hideAt(x); if (t > now && t < next) next = t; }
    if (next < Infinity) this.hideTimer = setTimeout(() => this.render(), Math.min(next - now + 30, 2_000_000_000));
  }
  markFresh(id) { this.freshUntil.set(id, Date.now() + 2500); }
  freshSet() {
    const now = Date.now();
    for (const [id, t] of this.freshUntil) if (t < now) this.freshUntil.delete(id);
    return new Set(this.freshUntil.keys());
  }
  popup() {
    const sec = this.s.eggsPopup;
    if (!(sec > 0)) return;
    this.popUntil = Date.now() + sec * 1000;
    clearTimeout(this.popTimer);
    this.popTimer = setTimeout(() => this.render(), sec * 1000 + 60);
  }
  hiddenByPopup() {
    const s = this.s;
    return !this.preview && s.eggsPopup > 0 && ['spotlight', 'events'].includes(s.eggsLayout) && Date.now() > this.popUntil;
  }
  visibleEvents() {
    let list = this.events;
    if (this.s.eggsHideAfter > 0) list = list.filter((x) => !this.isHidden(x));
    // One card per event name = when it LAST happened (list is newest first). Future event names work the same.
    const names = new Set();
    list = list.filter((x) => { const k = String(x.name || '').toLowerCase(); if (names.has(k)) return false; names.add(k); return true; });
    return list.slice(0, Math.max(1, this.s.eggsEventsCount || 3));
  }
  /** One event: icon · NAME · 9:14 AM · where · (summary / possible eggs) · ACTIVE/NEW badge. */
  eventCard(ev, fresh, big = false) {
    const s = this.s;
    const active = ev.endsAt && ev.endsAt > Date.now();
    const isNew = !active && s.eggsNewMinutes > 0 && Date.now() - ev.ts < s.eggsNewMinutes * 60_000;
    const card = el('div', 'egg-event' + (big ? ' big' : '') + (active ? ' active' : '') + (isNew ? ' is-new' : '') + (fresh.has(ev.id) ? ' enter' : ''));
    const c = safeColor(ev.color);
    if (c) card.style.setProperty('--ec', c);
    const top = el('div', 'egg-evtop');
    top.append(el('span', 'egg-evname', ev.name), el('span', 'egg-evtime', clock(ev.ts)));
    const body = el('div', 'egg-evbody');
    body.append(top);
    const sub = el('div', 'egg-evsub');
    if (ev.where) sub.append(el('span', 'egg-evwhere', `📍 ${ev.where}`));
    sub.append(this.ago(ev));
    body.append(sub);
    if (s.eggsEventDetails) {
      if (ev.note && big) body.append(el('div', 'egg-evnote', ev.note));
      if (ev.section?.lines?.length) {
        const lines = ev.section.lines.slice(0, big ? 5 : 3);
        const sec = el('div', 'egg-evsec');
        sec.append(el('span', 'egg-evsect', `${ev.section.title}:`), el('span', '', ` ${lines.join(' · ')}`));
        body.append(sec);
      }
    }
    const icon = eventIcon(ev, 'egg-evicon');
    if (this.s.alertLayout === 'text-top') card.append(body, icon);
    else card.append(icon, body);
    if (active) card.append(el('span', 'egg-evbadge', `ACTIVE · ${left(ev.endsAt - Date.now())} left`));
    else if (isNew) card.append(el('span', 'egg-evbadge', 'NEW'));
    return card;
  }
  eventsPanel(fresh, { big = false, title = 'Events' } = {}) {
    const list = this.visibleEvents();
    if (!list.length) return null;
    const panel = el('div', 'egg-panel egg-events');
    if (title) panel.append(el('h4', 'egg-head', `⚡ ${title}`));
    const wrap = el('div', 'egg-evlist');
    wrap.append(...list.map((ev, i) => this.eventCard(ev, fresh, big && i === 0)));
    panel.append(wrap);
    return panel;
  }
  /** "Last spawn" hero card: big picture, rarity, name, where, money, speed, 9:14 AM · 3m ago. */
  hero(e, fresh) {
    const card = el('div', 'egg-hero' + (fresh.has(e.id) ? ' enter' : '') + (this.isNew(e) ? ' is-new' : ''));
    card.style.setProperty('--rc', rarityColor(e.rarity));
    const kicker = el('div', 'egg-hkicker');
    const label = String(this.s.eggsEggLabel ?? '{rarity} egg spawned').replace(/\{rarity\}/gi, e.rarity || '').replace(/\s+/g, ' ').trim();
    kicker.append(el('span', 'egg-dot'), el('span', '', label || `${e.rarity || ''} egg spawned`.trim()));
    if (this.isNew(e)) kicker.append(el('span', 'egg-hlive', 'LIVE NOW'));
    const when = el('div', 'egg-hwhen');
    when.append(el('span', '', clock(e.ts)), el('span', 'egg-sep', '·'), this.ago(e));
    const meta = el('div', 'egg-hmeta');
    if (e.location) meta.append(el('span', '', `📍 ${e.location}`));
    meta.append(...this.details(e));
    const body = el('div', 'egg-hbody');
    body.append(kicker, el('div', 'egg-htitle', e.name), meta, when);
    const icon = eggIcon(e, 'egg-himg');
    if (this.s.alertLayout === 'text-top') card.append(body, icon);
    else card.append(icon, body);
    return card;
  }
  setSeen(list, redraw = true) { this.lastSeen = Array.isArray(list) ? list : []; if (redraw) this.render(); }
  isNew(e) { return this.s.eggsNewMinutes > 0 && Date.now() - e.ts < this.s.eggsNewMinutes * 60_000; }
  visible() {
    let list = this.items;
    if (this.s.eggsHideAfter > 0) list = list.filter((e) => !this.isHidden(e));
    return list.slice(0, Math.max(1, this.s.eggsCount));
  }
  ago(e) { const t = el('span', 'egg-ago', eggAgo(e.ts)); t.dataset.ts = e.ts; return t; }
  details(e) {
    const out = [];
    if (this.s.eggsDetails && e.money) out.push(el('span', 'egg-money', `💰 ${e.money}`));
    if (this.s.eggsDetails && e.speed) out.push(el('span', 'egg-speed', `⚡ ${e.speed}`));
    return out;
  }
  row(e, fresh, { withLocation }) {
    const li = el('li', 'egg-row' + (this.isNew(e) ? ' is-new' : '') + (fresh.has(e.id) ? ' enter' : ''));
    li.style.setProperty('--rc', rarityColor(e.rarity));
    li.dataset.ts = e.ts;
    li.append(e.image ? eggIcon(e, 'egg-rimg') : el('span', 'egg-dot'), el('span', 'egg-name', e.name));
    if (withLocation && e.location) li.append(el('span', 'egg-loc', `· ${e.location}`));
    li.append(el('span', 'egg-sep', '—'), this.ago(e), ...this.details(e).map((x) => { x.classList.add('egg-extra'); return x; }));
    return li;
  }
  latest(e, fresh) {
    const card = el('div', 'egg-latest' + (fresh.has(e.id) ? ' enter' : ''));
    card.style.setProperty('--rc', rarityColor(e.rarity));
    const kicker = el('div', 'egg-kicker');
    kicker.append(el('span', '', `${e.rarity ? `${e.rarity} egg` : 'New egg'} spawned`), this.ago(e));
    const meta = el('div', 'egg-meta');
    if (e.location) meta.append(el('span', '', `📍 ${e.location}`));
    meta.append(...this.details(e));
    const body = el('div', 'egg-lbody');
    body.append(kicker, el('div', 'egg-title', e.name), meta);
    if (e.image) { card.classList.add('with-img'); card.append(eggIcon(e, 'egg-limg')); }
    card.append(body);
    return card;
  }
  render() {
    this.draw();
    this.fitToScreen();
  }
  /**
   * OBS "fit to screen": find the biggest scale at which the whole overlay fits the window. The box is
   * laid out at width W/scale (so columns re-flow to the window's shape) and then scaled down/up.
   */
  fitToScreen() {
    const box = this.root.firstElementChild;
    if (!box) return;
    const reset = () => { box.style.width = ''; box.style.transform = ''; box.style.transformOrigin = ''; this.root.classList.remove('egg-fit'); };
    if (!this.fit || !this.s.eggsFit || this.s.eggsLayout === 'alert') { reset(); return; }
    this.root.classList.add('egg-fit'); // columns become automatic, so a wide window gets more columns
    const cs = getComputedStyle(this.root);
    const W = this.root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const H = this.root.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (W < 40 || H < 40) { reset(); return; }
    box.style.transformOrigin = 'top left';
    const fits = (k) => { box.style.width = `${W / k}px`; return box.offsetHeight * k <= H + 0.5; };
    let lo = 0.12;
    let hi = 2.5; // up to 2.5× on big screens with little content
    if (!fits(lo)) hi = lo;
    else for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    box.style.width = `${W / lo}px`;
    box.style.transform = `scale(${lo})`;
  }
  draw() {
    this.scheduleHide();
    const s = this.s;
    const fresh = this.freshSet();
    if (s.eggsLayout === 'alert') { const a = this.alert(fresh); this.root.replaceChildren(...(a ? [a] : [])); return; }
    if (this.hiddenByPopup()) { this.root.replaceChildren(); return; }
    const list = this.visible();
    const box = el('div', 'eggs-box');
    const showEvents = s.eggsEvents !== false;
    // With "Hide after" the overlay is empty once everything is gone (Studio keeps the "Waiting" text, so the preview is not just blank).
    const quiet = s.eggsHideAfter > 0 && !this.preview;
    const board = s.eggsLayout === 'board' && this.lastSeen.some((x) => !this.isHidden(x));
    if (quiet && (s.eggsLayout === 'events' || (!list.length && !board)) && !((showEvents || s.eggsLayout === 'events') && this.visibleEvents().length)) { this.root.replaceChildren(); return; }
    if (s.eggsLayout === 'spotlight' || s.eggsLayout === 'events') {
      box.classList.add('egg-spot');
      if (s.eggsLayout === 'spotlight') {
        if (list[0]) box.append(this.hero(list[0], fresh));
        else if (!quiet) box.append(el('div', 'egg-panel egg-empty', '🥚 Waiting for the next egg…'));
      }
      const ev = showEvents || s.eggsLayout === 'events' ? this.eventsPanel(fresh, { big: s.eggsLayout === 'events' && s.eggsOrient === 'vertical', title: s.eggsLayout === 'events' ? 'Game events' : 'Events' }) : null;
      if (ev) box.append(ev);
      else if (s.eggsLayout === 'events') box.append(el('div', 'egg-panel egg-empty', '⚡ Waiting for the next event…'));
      this.root.replaceChildren(box);
      return;
    }
    const evPanel = showEvents ? this.eventsPanel(fresh) : null;
    if (!list.length && !board) {
      if (evPanel) box.append(evPanel);
      if (!quiet) box.append(el('div', 'egg-panel egg-empty', '🥚 Waiting for the next egg…'));
      this.root.replaceChildren(box);
      return;
    }
    if (s.eggsLayout === 'board') {
      box.classList.add('egg-board');
      if (evPanel) box.append(evPanel);
      box.append(...this.board(fresh));
      this.root.replaceChildren(box);
      return;
    }
    const rest = s.eggsLatest ? list.slice(1) : list;
    if (s.eggsLatest) box.append(this.latest(list[0], fresh));
    if (evPanel) box.append(evPanel);
    if (s.eggsLayout === 'grouped') {
      const groups = new Map(); // location → eggs (keeps newest-first order of first appearance)
      for (const e of rest) {
        const k = e.location || 'Other';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
      }
      const grid = el('div', 'egg-groups');
      for (const [loc, eggs] of groups) {
        const ul = el('ul', 'egg-rows');
        ul.append(...eggs.map((e) => this.row(e, fresh, { withLocation: false })));
        const panel = el('div', 'egg-panel');
        panel.append(el('h4', 'egg-head', loc), ul);
        grid.append(panel);
      }
      if (groups.size) box.append(grid);
    } else if (rest.length) {
      const panel = el('div', 'egg-panel');
      if (s.eggsTitle) panel.append(el('h4', 'egg-head', s.eggsTitle));
      const ul = el('ul', 'egg-rows');
      ul.append(...rest.map((e) => this.row(e, fresh, { withLocation: s.eggsLocation })));
      panel.append(ul);
      box.append(panel);
    }
    this.root.replaceChildren(box);
  }
  /** Stock board: one panel per rarity, one tile per egg name (last time it was seen), newest first. */
  board(fresh) {
    const s = this.s;
    let items = [...this.items, ...this.lastSeen].sort((a, b) => b.ts - a.ts);
    if (s.eggsHideAfter > 0) items = items.filter((e) => !this.isHidden(e));
    const pics = new Map(); // name → any known picture (older feed items may not have one)
    for (const e of items) if (e.image && !pics.has(e.name.toLowerCase())) pics.set(e.name.toLowerCase(), e.image);
    const withPic = (e) => (e.image ? e : { ...e, image: pics.get(e.name.toLowerCase()) || null });
    const groups = new Map();
    for (const e of items) { // items are newest first → the first hit per name is its last sighting
      const k = String(e.rarity || 'Other');
      const key = k.toLowerCase();
      if (!groups.has(key)) groups.set(key, { label: k, names: new Set(), eggs: [] });
      const g = groups.get(key);
      const n = SPAWN_LIST[key] ? e.id : e.name.toLowerCase(); // spawn lists: one tile per spawn
      if (g.names.has(n)) continue;
      g.names.add(n);
      g.eggs.push(e);
    }
    const rank = (k) => { const i = RARITY_ORDER.indexOf(k); return i < 0 ? 99 : i; };
    return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([key, g]) => {
      const panel = el('section', 'egg-bpanel');
      panel.style.setProperty('--rc', rarityColor(key));
      const head = el('header', 'egg-bhead');
      const title = el('div', 'egg-btitle');
      title.append(el('span', 'egg-dot'), el('span', '', g.label));
      head.append(title);
      const top = g.eggs[0];
      if (s.eggsLatest && top) {
        const live = this.isNew(top);
        const pill = el('div', 'egg-bpill' + (live ? ' live' : '') + (fresh.has(top.id) ? ' enter' : ''));
        pill.append(el('span', 'egg-btag', live ? 'LIVE NOW' : 'LATEST'), eggIcon(withPic(top), 'egg-bicon'), el('span', 'egg-bpname', top.name),
          el('span', 'egg-bwhen', live ? 'NOW' : `LAST · ${eggShort(top.ts)} AGO`));
        head.append(pill);
      }
      head.append(el('span', 'egg-bseen', SPAWN_LIST[key] ? `LAST ${SPAWN_LIST[key]} SPAWNS` : 'LAST SEEN'));
      const grid = el('div', 'egg-tiles');
      for (const e of g.eggs.slice(0, SPAWN_LIST[key] || Math.max(1, s.eggsTiles))) {
        const live = this.isNew(e);
        const tile = el('div', 'egg-tile' + (live ? ' live' : '') + (fresh.has(e.id) ? ' enter' : ''));
        const info = el('div', 'egg-tinfo');
        info.append(el('span', 'egg-tname', e.name));
        if (s.eggsLocation && e.location) info.append(el('span', 'egg-tloc', e.location));
        if (s.eggsDetails && (e.money || e.speed)) info.append(el('span', 'egg-tloc egg-tdet', [e.money && `💰 ${e.money}`, e.speed && `⚡ ${e.speed}`].filter(Boolean).join('  ')));
        tile.append(eggIcon(withPic(e), 'egg-ticon'), info, el('span', 'egg-tpill', live ? 'LIVE NOW' : eggShort(e.ts)));
        grid.append(tile);
      }
      panel.append(head, grid);
      return panel;
    });
  }
  /** Update "8m ago" texts and NEW highlights without re-rendering. */
  refreshTimes() {
    if (['board', 'spotlight', 'events', 'alert'].includes(this.s.eggsLayout) || this.events.some((x) => x.endsAt)) { this.render(); return; }
    for (const t of this.root.querySelectorAll('.egg-ago')) t.textContent = eggAgo(Number(t.dataset.ts));
    for (const r of this.root.querySelectorAll('.egg-row')) r.classList.toggle('is-new', this.isNew({ ts: Number(r.dataset.ts) }));
  }
}

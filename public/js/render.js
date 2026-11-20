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

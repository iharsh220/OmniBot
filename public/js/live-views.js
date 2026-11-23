// Alerts, Goal and Poll overlays. All user text goes through textContent (XSS-safe).
// The alert cards reuse the eggs "Alert" markup/CSS (.egg-alert > .egg-hero), so the 7 alert looks,
// position, entry animation and exit animation work the same for both.
import { applyRoot } from './settings.js';
import { ICONS } from './render.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
};
const safeImg = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

// ── Alerts ──
const ALERT_TYPES = {
  superchat: { color: '#ffb300', label: (m) => `Super Chat${m.amount ? ` · ${m.amount}` : ''}`, setting: 'alertSuperchat' },
  sticker: { color: '#ff7aa8', label: (m) => `Super Sticker${m.amount ? ` · ${m.amount}` : ''}`, setting: 'alertSuperchat' },
  member: { color: '#2ecc71', label: () => 'New member', setting: 'alertMember' },
  milestone: { color: '#2ecc71', label: (m) => m.eventText || 'Member milestone', setting: 'alertMember' },
  gift: { color: '#a855f7', label: (m) => m.eventText || 'Gift', setting: 'alertGift' },
  sub: { color: '#53fc18', label: (m) => m.eventText || 'Subscribed!', setting: 'alertKickSub' },
  follow: { color: '#38bdf8', label: () => 'New follower', setting: 'alertFollow' },
  greeting: { color: '#38bdf8', label: () => '👋 Said hi', setting: 'alertGreeting' },
  highlight: { color: null, label: () => '⭐ Highlight', setting: 'alertHighlight' },
};
/** Alert type of a chat-stream message (older messages have no `alert` field). */
export function alertType(m) {
  if (!m) return null;
  if (m.alert) return m.alert;
  if (m.kind === 'superchat') return 'superchat';
  if (m.kind === 'member') return /gift/i.test(m.eventText || '') ? 'gift' : 'member';
  if (m.kind === 'sub') return /gift/i.test(m.eventText || '') ? 'gift' : 'sub';
  if (m.kind === 'follow') return 'follow';
  if (m.kind === 'greeting') return 'greeting';
  return null;
}

let audioCtx = null;
function chime(volume) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume / 100 * 0.35), t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    gain.connect(audioCtx.destination);
    [880, 1318.5].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t + i * 0.12);
      o.connect(gain);
      o.start(t + i * 0.12);
      o.stop(t + 0.9);
    });
  } catch { /* no audio in this browser */ }
}

export class AlertsView {
  constructor(root, settings) {
    this.root = root;
    this.queue = [];
    this.current = null;
    this.until = 0;
    this.leaving = false;
    this.preview = false; // Studio: no sound, never empty
    this.last = null; // newest alert seen (preview / "always visible")
    this.setSettings(settings);
  }
  setSettings(s) {
    this.s = s;
    applyRoot(this.root, { ...s, eggsLayout: 'alert' }, 'eggs');
    this.root.classList.add('ow-alerts');
    this.render();
  }
  enabled(m) {
    const t = ALERT_TYPES[alertType(m)];
    return !!t && this.s[t.setting] !== false;
  }
  /** New message from the live stream. Non-alert messages are ignored. */
  add(m) {
    if (m?.kind === 'highlight-clear') {
      this.queue = this.queue.filter((x) => alertType(x) !== 'highlight');
      if (this.current && alertType(this.current) === 'highlight') this.hideNow();
      return;
    }
    if (!this.enabled(m)) return;
    this.last = m;
    this.queue.push(m);
    if (this.queue.length > 10) this.queue = this.queue.slice(-10);
    this.advance();
  }
  hideNow() {
    clearTimeout(this.timer);
    this.leaving = true;
    this.render();
    this.timer = setTimeout(() => { this.leaving = false; this.current = null; this.advance(); this.render(); }, 450);
  }
  advance() {
    const sec = this.s.eggsPopup;
    if (this.current && (sec <= 0 ? false : Date.now() < this.until)) return;
    const next = this.queue.shift();
    if (next) {
      this.current = next;
      this.leaving = false;
      this.fresh = next.id;
      if (this.s.alertSound && !this.preview) chime(this.s.alertVolume);
      clearTimeout(this.timer);
      if (sec > 0) {
        this.until = Date.now() + sec * 1000;
        this.timer = setTimeout(() => { this.advance(); }, sec * 1000 + 40);
      }
      this.render();
    } else if (sec > 0 && this.current && !this.leaving) this.hideNow();
  }
  card(m) {
    const type = alertType(m);
    const t = ALERT_TYPES[type];
    const card = el('div', `egg-hero oc-alert oc-${type}${m.id === this.fresh ? ' enter' : ''}`);
    card.style.setProperty('--rc', t.color || 'var(--accent)');
    const pic = el('span', 'egg-himg' + (safeImg(m.author?.avatar) ? ' has-img oc-avatar' : ''));
    const src = safeImg(m.author?.avatar);
    if (src) {
      const img = document.createElement('img');
      img.src = src; img.alt = ''; img.referrerPolicy = 'no-referrer';
      img.onerror = () => { pic.classList.remove('has-img'); pic.textContent = type === 'follow' ? '💚' : '⭐'; };
      pic.append(img);
    } else pic.textContent = { superchat: '💰', sticker: '💖', member: '⭐', milestone: '🏅', gift: '🎁', sub: '💚', follow: '💚', greeting: '👋', highlight: '⭐' }[type] || '⭐';
    const kicker = el('div', 'egg-hkicker');
    const plat = el('span', 'oc-plat');
    plat.innerHTML = m.platform === 'kick' ? ICONS.kick : m.platform === 'youtube' ? ICONS.youtube : '';
    kicker.append(plat, el('span', '', t.label(m)));
    const body = el('div', 'egg-hbody');
    body.append(kicker, el('div', 'egg-htitle', m.author?.name || 'Someone'));
    if (this.s.alertMessage) {
      const text = el('div', 'oc-amsg');
      for (const p of m.parts || []) {
        if (p.type === 'emote' && safeImg(p.url)) {
          const i = document.createElement('img');
          i.src = p.url; i.alt = p.name || ''; i.className = 'oc-emote'; i.referrerPolicy = 'no-referrer';
          text.append(i);
        } else if (p.text) text.append(document.createTextNode(p.text));
      }
      if (text.childNodes.length) body.append(text);
    }
    card.append(pic, body);
    return card;
  }
  render() {
    const m = this.current || (this.preview || this.s.eggsPopup <= 0 ? this.last : null);
    if (!m) { this.root.replaceChildren(); return; }
    const box = el('div', 'eggs-box egg-alert' + (this.leaving && !this.preview ? ' leaving' : ''));
    box.append(this.card(m));
    this.root.replaceChildren(box);
  }
}

// ── Goal ──
export class GoalView {
  constructor(root, settings) {
    this.root = root;
    this.state = null;
    this.setSettings(settings);
  }
  setSettings(s) { this.s = s; applyRoot(this.root, s, 'goal'); this.render(); }
  setState(st) { this.state = st; this.render(); }
  current() {
    const st = this.state || {};
    const yt = st.youtube?.connected ? st.youtube.subscribers : null;
    const kk = st.kick?.connected ? st.kick.followers : null;
    if (this.s.goalType === 'kick-followers') return kk;
    if (this.s.goalType === 'combined') return yt == null && kk == null ? null : (yt || 0) + (kk || 0);
    return yt;
  }
  render() {
    const s = this.s;
    const cur = this.current();
    const target = Math.max(1, s.goalTarget || 1);
    const pct = cur == null ? 0 : Math.min(100, (cur / target) * 100);
    const card = el('div', 'oc-goal' + (cur != null && cur >= target ? ' done' : ''));
    const head = el('div', 'oc-ghead');
    head.append(el('span', 'oc-gtitle', s.goalTitle || 'Goal'));
    const pctText = cur == null ? '—' : cur >= target ? 'Goal reached! 🎉' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
    const nums = s.goalNumbers ? `${fmtN(cur)} / ${fmtN(target)}` : '';
    const slim = s.goalStyle === 'slim';
    const right = [nums, slim && s.goalPercent ? pctText : ''].filter(Boolean).join(' · ');
    if (right) head.append(el('span', 'oc-gnums', right));
    const bar = el('div', 'oc-gbar');
    const fill = el('div', 'oc-gfill');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    if (s.goalPercent && !slim) bar.append(el('span', 'oc-gpct', pctText));
    card.append(head, bar);
    this.root.replaceChildren(card);
  }
}

// ── Poll ──
export class PollView {
  constructor(root, settings) {
    this.root = root;
    this.poll = null;
    this.preview = false;
    this.setSettings(settings);
    this.tick = setInterval(() => this.render(), 1000);
  }
  setSettings(s) { this.s = s; applyRoot(this.root, s, 'poll'); this.render(); }
  setPoll(p) { this.poll = p; this.render(); }
  render() {
    const p = this.poll;
    const s = this.s;
    const now = Date.now();
    const open = p && p.open && now < p.endsAt;
    if (!p || (!open && s.pollHideIdle && !this.preview && now - p.endsAt > 60_000)) { this.root.replaceChildren(); return; }
    const card = el('div', 'oc-poll' + (open ? '' : ' ended'));
    const head = el('div', 'oc-phead');
    const left = Math.max(0, Math.ceil((p.endsAt - now) / 1000));
    head.append(el('span', 'oc-pq', p.question),
      el('span', 'oc-ptime', open ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Ended'));
    card.append(head);
    const max = Math.max(...p.options.map((o) => o.votes));
    p.options.forEach((o, i) => {
      const pct = p.total ? (o.votes / p.total) * 100 : 0;
      const row = el('div', 'oc-popt' + (!open && o.votes === max && max > 0 ? ' win' : ''));
      const fill = el('div', 'oc-pfill');
      fill.style.width = `${pct}%`;
      row.append(fill, el('span', 'oc-pnum', String(i + 1)), el('span', 'oc-ptext', o.text), el('span', 'oc-pvotes', `${Math.round(pct)}% · ${o.votes}`));
      card.append(row);
    });
    const foot = el('div', 'oc-pfoot');
    foot.append(el('span', '', `${fmtN(p.total)} vote${p.total === 1 ? '' : 's'}`));
    if (s.pollHint && open) foot.append(el('span', '', `Type !vote 1–${p.options.length} in chat`));
    card.append(foot);
    this.root.replaceChildren(card);
  }
}

// ── Demos (Studio preview / /demo?type=…) ──
const DEMO_ALERTS = [
  { alert: 'superchat', kind: 'superchat', amount: '₹500.00', author: 'PixelPanda', text: 'Bhai op stream! Keep it up ❤️' },
  { alert: 'member', kind: 'member', author: 'NightOwl_42', text: '' },
  { alert: 'sub', kind: 'sub', platform: 'kick', author: 'TurboTaco', eventText: 'Resubscribed (3 months)!', text: '' },
  { alert: 'follow', kind: 'follow', platform: 'kick', author: 'ByteBandit', text: '' },
  { alert: 'gift', kind: 'member', author: 'CaptainChai', eventText: 'Gifted 5 memberships', text: '' },
  { alert: 'milestone', kind: 'member', author: 'Lofi Lover', eventText: 'Member for 12 months', text: 'One year already!' },
  { alert: 'highlight', kind: 'highlight', author: 'zara_streams', text: 'Can you show the Divine egg spot again?' },
];
let demoN = 0;
export function startAlertDemo(onAlert, everyMs = 4500) {
  const make = () => {
    const d = DEMO_ALERTS[demoN % DEMO_ALERTS.length];
    demoN += 1;
    return { id: `demo-al-${demoN}`, platform: d.platform || 'youtube', ts: Date.now(), kind: d.kind, alert: d.alert, amount: d.amount, eventText: d.eventText, author: { name: d.author, avatar: null }, parts: d.text ? [{ type: 'text', text: d.text }] : [] };
  };
  onAlert(make());
  const t = setInterval(() => onAlert(make()), everyMs);
  return { stop() { clearInterval(t); } };
}
export function demoPoll() {
  const now = Date.now();
  return { id: 'demo', question: 'Which egg do we hunt next?', options: [{ text: 'Divine', votes: 42 }, { text: 'Eternal', votes: 27 }, { text: 'Secret', votes: 13 }], total: 82, startedAt: now, endsAt: now + 95_000, open: true };
}
export const demoGoalState = () => ({ youtube: { connected: true, subscribers: 27830 }, kick: { connected: true, followers: 1240 } });

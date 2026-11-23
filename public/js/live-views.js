// Alerts, Goal and Poll overlays. All user text goes through textContent (XSS-safe).
// The alert cards reuse the eggs "Alert" markup/CSS (.egg-alert > .egg-hero), so the 7 alert looks,
// position, entry animation and exit animation work the same for both.
import { applyRoot, ALERT_KINDS, httpsUrl } from './settings.js';
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
// alert type → settings key part (ALERT_KINDS in settings.js) + colour + fallback icon
const KIND_OF = { superchat: 'Superchat', sticker: 'Superchat', member: 'Member', milestone: 'Member', gift: 'Gift', sub: 'KickSub', follow: 'Follow', greeting: 'Greeting', highlight: 'Highlight' };
const COLOR = { superchat: '#ffb300', sticker: '#ff7aa8', member: '#2ecc71', milestone: '#2ecc71', gift: '#a855f7', sub: '#53fc18', follow: '#38bdf8', greeting: '#38bdf8', highlight: null };
const ICON = { superchat: '💰', sticker: '💖', member: '⭐', milestone: '🏅', gift: '🎁', sub: '💚', follow: '💚', greeting: '👋', highlight: '⭐' };
const DEFAULT_EVENT = { superchat: 'Super Chat', sticker: 'Super Sticker', member: 'New member!', milestone: 'Member milestone', gift: 'Gift!', sub: 'Subscribed!', follow: 'Followed!', greeting: 'Said hi', highlight: 'Highlight' };
const DEFAULT_SOUND = Object.fromEntries(ALERT_KINDS.map(([k, , snd]) => [k, snd]));
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

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

// ── Sounds: a different built-in sound per alert kind (WebAudio, no files), or the streamer's own URL ──
let audioCtx = null;
function synth(name, volume) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const ctx = audioCtx;
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = Math.max(0, Math.min(1, volume / 100)) * 0.5;
    out.connect(ctx.destination);
    const tone = (freq, start, dur, { type = 'sine', to = null, vol = 0.6 } = {}) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0 + start);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + start + dur);
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(vol, t0 + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(g); g.connect(out);
      o.start(t0 + start); o.stop(t0 + start + dur + 0.05);
    };
    const S = {
      chime: () => { tone(880, 0, 0.8); tone(1318.5, 0.12, 0.8); },
      coin: () => { tone(988, 0, 0.09, { type: 'square', vol: 0.35 }); tone(1319, 0.08, 0.5, { type: 'square', vol: 0.35 }); },
      fanfare: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.11, i === 3 ? 0.7 : 0.18, { type: 'triangle' })); },
      pop: () => { tone(420, 0, 0.12, { to: 980 }); tone(980, 0.1, 0.15, { vol: 0.25 }); },
      sparkle: () => { [2093, 2637, 3136, 2349, 2794, 3520].forEach((f, i) => tone(f, i * 0.06, 0.25, { vol: 0.3 })); },
      bell: () => { tone(1046.5, 0, 1.4, { vol: 0.5 }); tone(2093, 0, 0.9, { vol: 0.15 }); tone(1568, 0.02, 1.1, { vol: 0.12 }); },
      levelup: () => { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, i * 0.07, i === 4 ? 0.5 : 0.1, { type: 'square', vol: 0.25 })); },
      whoosh: () => {
        const len = Math.floor(ctx.sampleRate * 0.6);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = ctx.createBufferSource();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(300, t0); bp.frequency.exponentialRampToValueAtTime(3000, t0 + 0.5);
        src.buffer = buf; src.connect(bp); bp.connect(out); src.start(t0);
      },
    };
    (S[name] || S.chime)();
  } catch { /* no audio in this browser */ }
}
/** Plays the sound configured for this alert kind. */
export function playAlertSound(s, type) {
  const K = KIND_OF[type];
  if (!K || !s.alertSound) return;
  const choice = s[`alert${K}Sound`] || 'default';
  if (choice === 'none') return;
  if (choice === 'custom') {
    const url = httpsUrl(s[`alert${K}SoundUrl`]);
    if (url) {
      try { const a = new Audio(url); a.volume = Math.max(0, Math.min(1, s.alertVolume / 100)); a.play().catch(() => synth(DEFAULT_SOUND[K], s.alertVolume)); } catch { /* ignore */ }
      return;
    }
  }
  synth(choice === 'default' || choice === 'custom' ? DEFAULT_SOUND[K] : choice, s.alertVolume);
}

/** A fake alert of one type (Studio "Test" buttons). */
export function sampleAlert(type) {
  const base = { id: `sample-${type}-${Date.now()}`, ts: Date.now(), platform: 'youtube', alert: type, n: Math.floor(Math.random() * 5) + 1, author: { name: 'PixelPanda', avatar: null }, parts: [] };
  const msg = (t) => [{ type: 'text', text: t }];
  return {
    superchat: { ...base, kind: 'superchat', amount: '₹500.00', parts: msg('Bhai op stream! Keep it up ❤️') },
    member: { ...base, kind: 'member', eventText: 'New member!' },
    gift: { ...base, kind: 'member', eventText: 'Gifted 5 memberships', author: { name: 'CaptainChai' } },
    sub: { ...base, kind: 'sub', platform: 'kick', eventText: 'Resubscribed (3 months)!', author: { name: 'TurboTaco' } },
    follow: { ...base, kind: 'follow', platform: 'kick', eventText: 'Followed!', author: { name: 'ByteBandit' } },
    greeting: { ...base, kind: 'greeting', eventText: '👋 said hi', author: { name: 'Neha' } },
    highlight: { ...base, kind: 'highlight', author: { name: 'zara_streams' }, parts: msg('Can you show the Divine egg spot again?') },
  }[type];
}

export class AlertsView {
  constructor(root, settings) {
    this.root = root;
    this.queue = [];
    this.current = null;
    this.until = 0;
    this.leaving = false;
    this.preview = false; // Studio: no automatic sound, never empty
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
    const K = KIND_OF[alertType(m)];
    return !!K && this.s[`alert${K}`] !== false;
  }
  /** New message from the live stream. Non-alert messages are ignored. `sound` forces the sound (Studio tests). */
  add(m, { sound = false } = {}) {
    if (m?.kind === 'highlight-clear') {
      this.queue = this.queue.filter((x) => alertType(x) !== 'highlight');
      if (this.current && alertType(this.current) === 'highlight') this.hideNow();
      return;
    }
    if (!this.enabled(m)) return;
    m.forceSound = sound;
    this.last = m;
    this.queue.push(m);
    if (this.queue.length > 10) this.queue = this.queue.slice(-10);
    this.advance();
  }
  /** Studio test button: show + play one alert of this type now (skips the queue). */
  test(type) {
    const m = sampleAlert(type);
    if (!m) return;
    this.queue = [];
    this.current = null;
    this.leaving = false;
    this.add(m, { sound: true });
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
      if (!this.preview || next.forceSound) playAlertSound(this.s, alertType(next));
      clearTimeout(this.timer);
      if (sec > 0) {
        this.until = Date.now() + sec * 1000;
        this.timer = setTimeout(() => { this.advance(); }, sec * 1000 + 40);
      }
      this.render();
    } else if (sec > 0 && this.current && !this.leaving) this.hideNow();
  }
  label(m, type, K) {
    const tpl = String(this.s[`alert${K}Text`] ?? '').trim() || ALERT_KINDS.find(([k]) => k === K)?.[1] || '{event}';
    return tpl
      .replace(/\{name\}/gi, m.author?.name || 'Someone')
      .replace(/\{amount\}/gi, m.amount || '')
      .replace(/\{event\}/gi, m.eventText || DEFAULT_EVENT[type] || '')
      .replace(/\{count\}/gi, m.n ? ordinal(m.n) : '')
      .replace(/\{platform\}/gi, m.platform === 'kick' ? 'Kick' : 'YouTube')
      .replace(/\s*·\s*$/, '').replace(/\s+/g, ' ').trim();
  }
  card(m) {
    const type = alertType(m);
    const K = KIND_OF[type];
    const card = el('div', `egg-hero oc-alert oc-${type}${m.id === this.fresh ? ' enter' : ''}`);
    card.style.setProperty('--rc', COLOR[type] || 'var(--accent)');
    const custom = httpsUrl(this.s[`alert${K}Image`]);
    const src = custom || safeImg(m.author?.avatar);
    const pic = el('span', 'egg-himg' + (src ? ` has-img ${custom ? 'oc-custom' : 'oc-avatar'}` : ''));
    if (src) {
      const img = document.createElement('img');
      img.src = src; img.alt = ''; img.referrerPolicy = 'no-referrer';
      img.onerror = () => { pic.className = 'egg-himg'; pic.textContent = ICON[type] || '⭐'; };
      pic.append(img);
    } else pic.textContent = ICON[type] || '⭐';
    const kicker = el('div', 'egg-hkicker');
    const plat = el('span', 'oc-plat');
    plat.innerHTML = m.platform === 'kick' ? ICONS.kick : m.platform === 'youtube' ? ICONS.youtube : '';
    kicker.append(plat, el('span', '', this.label(m, type, K)));
    if (this.s.alertCount && m.n && type !== 'highlight') kicker.append(el('span', 'oc-count', `#${m.n} this stream`));
    if (m.test) kicker.append(el('span', 'oc-count', 'TEST'));
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

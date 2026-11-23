// Live feed by polling the API (works on serverless functions) + demo generator for previews.
//
// connectLive(url, handlers, { v, interval }) polls `url?c=<cursor>&v=<version>&l=<logCursor>`.
// Handlers: onHistory(list) · onChat(msg) · onDelete(id) · onState(state, only when changed)
//           onSettings({settings}) · onLog(row) · onStatus(ok)
export function connectLive(url, handlers = {}, opts = {}) {
  const h = handlers;
  let cursor = null;
  let logCursor = null;
  let v = opts.v ?? null;
  let lastState = '';
  let fails = 0;
  let stopped = false;
  let timer = null;
  const every = () => (document.hidden ? 15_000 : opts.interval || 4_000);

  async function poll() {
    if (stopped) return;
    try {
      const q = new URLSearchParams();
      if (cursor !== null) q.set('c', cursor);
      if (logCursor !== null) q.set('l', logCursor);
      if (v !== null) q.set('v', v);
      const r = await fetch(`${url}?${q}`, { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) {
        // Double-check before signing out (avoid a one-off glitch logging the user out).
        const me = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
        if (me && me.status === 401) { const j = await me.json().catch(() => ({})); h.onUnauthorized?.(j.reason); return; }
        throw new Error('auth check');
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      fails = 0;
      h.onStatus?.(true);
      if (d.history) h.onHistory?.(d.history);
      for (const e of d.events || []) (e.t === 'chat' ? h.onChat?.(e.msg) : h.onDelete?.(e.id));
      cursor = d.cursor ?? cursor;
      if (d.state) {
        const s = JSON.stringify(d.state);
        if (s !== lastState) { lastState = s; h.onState?.(d.state); }
      }
      if (d.settings && v !== null && d.v !== v) h.onSettings?.({ settings: d.settings });
      if (d.v !== undefined) v = d.v;
      if (d.seen) h.onSeen?.(d.seen);
      if (d.eggs) h.onEggs?.(d.eggs);
      if (d.eggEvents) h.onEggEvents?.(d.eggEvents);
      if ('poll' in d) h.onPoll?.(d.poll);
      if ('donate' in d) h.onDonate?.(d.donate);
      for (const l of d.logs || []) h.onLog?.(l);
      if (d.logCursor !== undefined) logCursor = d.logCursor;
    } catch {
      fails += 1;
      h.onStatus?.(false);
    }
    if (!stopped) timer = setTimeout(poll, fails ? Math.min(30_000, 2_000 * 2 ** fails) : every());
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !stopped) { clearTimeout(timer); poll(); } });
  poll();
  return { close() { stopped = true; clearTimeout(timer); } };
}

const NAMES = ['PixelPanda', 'NightOwl_42', 'Ravi Kumar', 'GG_Warrior', 'sneha.codes', 'TurboTaco', 'xXShadowXx', 'Lofi Lover', 'AmanPlays', 'CaptainChai', 'zara_streams', 'MemeLord99', 'Neha', 'ByteBandit', 'FrostFire'];
const LINES = [
  'Hello bhai! 👋', 'Kya gameplay hai 🔥🔥', 'first time here, loving the stream', 'LETS GOOO 🚀', 'clip that!!',
  'Bhai settings kya hai?', 'GG wp 😂', 'Audio thoda low hai', 'this overlay looks clean ngl', 'W streamer',
  'Kal kitne baje live aaoge?', 'lol 😂😂', 'Which mouse do you use?', 'Hype hype hype 🎉', 'Respect from Mumbai 🇮🇳',
  'that was insane', 'Bro carry kar diya', 'pog', 'Good night everyone 🌙', 'Chat is so active today',
];
const BADGE_SETS = [
  [], [], [], [], [{ type: 'moderator', label: 'Moderator' }], [{ type: 'member', label: 'Member' }],
  [{ type: 'subscriber', label: 'Subscriber' }], [{ type: 'vip', label: 'VIP' }], [{ type: 'verified', label: 'Verified' }],
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
let seq = 0;

export function demoMessage(platforms = ['youtube', 'kick']) {
  const platform = pick(platforms.length ? platforms : ['youtube']);
  const name = pick(NAMES);
  const r = Math.random();
  const base = {
    id: `demo-${Date.now()}-${seq++}`,
    platform,
    ts: Date.now(),
    kind: 'chat',
    author: { name, avatar: null, color: null, badges: pick(BADGE_SETS).filter((b) => platform === 'kick' ? b.type !== 'member' : b.type !== 'subscriber' && b.type !== 'vip') },
    parts: [{ type: 'text', text: pick(LINES) }],
  };
  if (r < 0.03 && platform === 'youtube') return { ...base, kind: 'greeting', eventText: '👋 said hi', parts: [] };
  if (r < 0.06 && platform === 'youtube') return { ...base, kind: 'superchat', amount: pick(['₹100.00', '₹500.00', '$5.00', '₹2,000.00']), eventText: 'Super Chat', parts: [{ type: 'text', text: 'Keep it up bhai! ❤️' }] };
  if (r < 0.09 && platform === 'youtube') return { ...base, kind: 'member', eventText: 'New member!', parts: [] };
  if (r < 0.12 && platform === 'kick') return { ...base, kind: 'sub', eventText: 'Subscribed for 3 months!', parts: [] };
  if (r < 0.14) base.author.badges = [{ type: 'broadcaster', label: 'Broadcaster' }];
  return base;
}

export function startDemo({ onChat, onState, platforms = () => ['youtube', 'kick'] } = {}) {
  const st = {
    youtube: { connected: true, live: true, viewers: 1243, subscribers: 15320, channelName: 'Your YouTube', chatConnected: true },
    kick: { connected: true, live: true, viewers: 836, followers: 9412, channelName: 'Your Kick', chatConnected: true },
  };
  onState?.(structuredClone(st));
  let t;
  const tick = () => {
    onChat?.(demoMessage(platforms()));
    t = setTimeout(tick, 900 + Math.random() * 1700);
  };
  for (let i = 0; i < 4; i++) onChat?.(demoMessage(platforms()));
  tick();
  const s = setInterval(() => {
    st.youtube.viewers = Math.max(0, st.youtube.viewers + Math.round((Math.random() - 0.45) * 40));
    st.kick.viewers = Math.max(0, st.kick.viewers + Math.round((Math.random() - 0.45) * 30));
    if (Math.random() < 0.3) st.youtube.subscribers += 1;
    if (Math.random() < 0.3) st.kick.followers += 1;
    onState?.(structuredClone(st));
  }, 3000);
  return { stop() { clearTimeout(t); clearInterval(s); } };
}

// ── Demo eggs for previews (/demo?type=eggs and the Studio preview) ──
const DEMO_EGGS = [
  ['Stormclaw Wolf', 'Secret', 'Stormlands', '~$36m/s', '150M'], ['Centaur', 'Secret', 'Angels', '~$350m/s', '20B'],
  ['Mosasaurus', 'Eternal', 'Prehistoric', '~$180m/s', '20.5M'], ['King Snake', 'Secret', 'Jungle', '~$3.5m/s', '50K'],
  ['Tempest Bull', 'Eternal', 'Stormlands', '~$215m/s', '150M'], ['Gargoyle', 'Secret', 'Demons', '~$225m/s', '20B'],
  ['Pure Jellyfish', 'Secret', 'Angels', '~$225m/s', '20B'], ['Tideler', 'Secret', 'Aliens', '~$2.8b/s', '250B'],
  ['Kitsune', 'Eternal', 'Cherry Blossom', '~$90m/s', '5B'], ['Kraken', 'Secret', 'Abyss Ocean', '~$410m/s', '40B'],
  ['Lava Dragon', 'Eternal', 'Volcano', '~$120m/s', '8B'], ['Ice Dragon', 'Secret', 'Snow', '~$75m/s', '3B'],
  ['Royal Skywhale', 'Divine', 'Sky Islands', '~$1.2b/s', '500B'], ['Phoenix', 'Eternal', 'Volcano', '~$140m/s', '9B'],
  ['Cosmic Dragon', 'Secret', 'Space', '~$95m/s', '6B'], ['Archangel', 'Divine', 'Angels', '~$900m/s', '300B'],
  ['Yeti', 'Secret', 'Snow', '~$60m/s', '2B'], ['Unicorn', 'Divine', 'Cherry Blossom', '~$700m/s', '200B'],
  ['Pegasus', 'Eternal', 'Angels', '~$160m/s', '10B'], ['Cerberus', 'Secret', 'Demons', '~$250m/s', '22B'],
];
let demoSeq = 0;
const demoEgg = (i, ts) => {
  const [name, rarity, location, money, speed] = DEMO_EGGS[i % DEMO_EGGS.length];
  return { id: `demo-egg-${demoSeq++}`, ts, name, rarity, location, money, speed };
};
// Demo game events, shaped like the parsed "SenZ V2 | Steal An Egg Event Alert" embeds.
const DEMO_EVENTS = [
  { name: 'TIDAL SURGE', emoji: '🌊', color: '#46e1ff', where: 'Alien Planet (Aliens biome, 250B Speed)', note: 'The Alien Planet just flooded in every server - Flooded eggs can spawn there until the next egg reset.',
    section: { title: 'Possible Eggs', lines: ['Jellynova · Cosmic · 73%', 'Flarefish · Cosmic · 20%', 'Tideler · Secret · 5%', 'Abyssjaw · Eternal · 1.9%', 'Prismare · Divine · 0.1%'] } },
  { name: 'BUTTERFLY BLOOM', emoji: '🦋', color: '#ff69b4', where: 'Enchanted Tree · Enchanted Forest', note: 'Butterflies are swarming the Enchanted Tree — grab your Butterfly Net!',
    section: { title: 'Why Catch Them', lines: ['Trade them up at the Butterfly Trade Up', 'Craft Enchanted Essence → guaranteed Enchanted ×2.85'] } },
  { name: 'SLICK RICK IS HERE', emoji: '🕶️', color: '#d4a017', where: 'Alien Planet • ⚡ 250B Speed', leaves: 5,
    section: { title: 'Sells', lines: ['Fractured • Nitro • Blacklisted • Spirit Bloom', '🥚 Smuggled & Contraband Eggs • ⚔️ Bat skins • 🏠 Base skins'] } },
];
const demoEvent = (i, ts) => {
  const d = DEMO_EVENTS[i % DEMO_EVENTS.length];
  return { id: `demo-ev-${demoSeq++}`, kind: 'event', ts, image: null, duration: null, note: null, ...d, endsAt: d.leaves ? ts + d.leaves * 60_000 : null };
};
/** Calls onEggs(list newest-first) now and whenever a new demo egg "spawns"; onEvents likewise for events. */
export function startEggDemo(onEggs, everyMs = 6000, onEvents = null) {
  let events = [demoEvent(0, Date.now() - 9 * 60_000), demoEvent(1, Date.now() - 70 * 60_000), demoEvent(2, Date.now() - 150 * 60_000)];
  onEvents?.(events);
  let j = 3;
  const te = onEvents ? setInterval(() => { events = [demoEvent(j++, Date.now()), ...events].slice(0, 10); onEvents(events); }, everyMs * 2.5) : null;
  // Divine eggs are rare: in the demo they were last seen hours/days ago.
  let list = DEMO_EGGS.map((d, i) => demoEgg(i, Date.now() - (d[1] === 'Divine' ? (i * 9 + 20) * 3_600_000 : (i * 7 + 2) * 60_000)));
  onEggs(list);
  let i = 3;
  const t = setInterval(() => { list = [demoEgg(i++, Date.now()), ...list].slice(0, 40); onEggs(list); }, everyMs);
  return { stop() { clearInterval(t); clearInterval(te); } };
}

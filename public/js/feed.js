// Live feed (Server-Sent Events from the Node server) + demo generator for previews.

export function connectLive(url, { onState, onChat, onDelete, onHistory, onStatus, onSettings, onLog } = {}) {
  let es;
  let closed = false;
  const open = () => {
    es = new EventSource(url);
    es.onopen = () => onStatus?.(true);
    es.onerror = () => onStatus?.(false);
    es.addEventListener('state', (e) => onState?.(JSON.parse(e.data)));
    es.addEventListener('history', (e) => onHistory?.(JSON.parse(e.data)));
    es.addEventListener('chat', (e) => onChat?.(JSON.parse(e.data)));
    es.addEventListener('delete', (e) => onDelete?.(JSON.parse(e.data).id));
    es.addEventListener('settings', (e) => onSettings?.(JSON.parse(e.data)));
    es.addEventListener('log', (e) => onLog?.(JSON.parse(e.data)));
  };
  open();
  return { close() { closed = true; es?.close(); }, get closed() { return closed; } };
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

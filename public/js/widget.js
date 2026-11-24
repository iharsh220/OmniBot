import { DEFAULTS, decodeSettings } from '/js/settings.js';
import { ChatView, StatsView, EggsView } from '/js/render.js';
import { connectLive, startDemo, startEggDemo } from '/js/feed.js';
import { AlertsView, GoalView, PollView, DonateView, startAlertDemo, demoPoll, demoGoalState, demoDonate } from '/js/live-views.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const id = (location.pathname.match(/^\/w\/([\w-]+)/) || [])[1];

async function main() {
  let type = ['stats', 'eggs', 'alerts', 'goal', 'poll', 'donate'].includes(params.get('type')) ? params.get('type') : 'chat';
  let base = DEFAULTS;
  let version = null;
  if (id) {
    const r = await fetch(`/api/w/${id}`);
    if (!r.ok) throw new Error('Widget not found — copy the URL again from your OmniChat dashboard.');
    const cfg = await r.json();
    type = cfg.type;
    base = { ...DEFAULTS, ...cfg.settings };
    version = cfg.v ?? null;
  }
  // URL query params (optional) override the saved settings.
  const settingsFor = (b) => decodeSettings(location.search, b);
  const s = settingsFor(base);
  const VIEWS = { stats: StatsView, eggs: EggsView, alerts: AlertsView, goal: GoalView, poll: PollView, donate: DonateView, chat: ChatView };
  const view = new (VIEWS[type] || ChatView)(app, s);
  const onSettings = ({ settings }) => view.setSettings(settingsFor({ ...DEFAULTS, ...settings }));
  const demoMode = !id || params.get('demo') === '1';

  if (type === 'alerts') {
    if (demoMode) { startAlertDemo((m) => view.add(m), 5000); return; }
    // First poll returns recent history → never alert old things; only new events after that.
    connectLive(`/api/w/${id}/poll`, {
      // show alerts from the last 20 s (e.g. a test sent just before the page opened), never older ones
      onHistory: (list) => list.filter((m) => Date.now() - (m.ts || 0) < 20_000).forEach((m) => view.add(m)),
      onChat: (m) => view.add(m), onSettings,
    }, { v: version, interval: 3_000 });
    return;
  }
  if (type === 'goal') {
    if (demoMode) { view.setState(demoGoalState()); return; }
    connectLive(`/api/w/${id}/poll`, { onState: (st) => view.setState(st), onSettings }, { v: version, interval: 15_000 });
    return;
  }
  if (type === 'donate') {
    if (demoMode) { view.setData(demoDonate()); return; }
    connectLive(`/api/w/${id}/poll`, { onDonate: (d) => view.setData(d), onSettings }, { v: version, interval: 30_000 });
    return;
  }
  if (type === 'poll') {
    if (demoMode) { view.setPoll(demoPoll()); return; }
    connectLive(`/api/w/${id}/poll`, { onPoll: (p) => view.setPoll(p), onSettings }, { v: version, interval: 3_000 });
    return;
  }
  if (type === 'eggs') {
    view.fit = true; // OBS: everything always fits the browser source, whatever its resolution
    view.render();
    let rt = null;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => view.fitToScreen(), 100); });
    document.fonts?.ready.then(() => view.fitToScreen());
  }

  if (type === 'eggs') {
    if (!id || params.get('demo') === '1') { startEggDemo((list) => view.setItems(list), 6000, (list) => view.setEvents(list)); return; }
    connectLive(`/api/w/${id}/poll`, {
      onSeen: (list) => view.setSeen(list),
      onEggs: (list) => view.setItems(list),
      onEggEvents: (list) => view.setEvents(list),
      onSettings: ({ settings }) => view.setSettings(settingsFor({ ...DEFAULTS, ...settings })),
    }, { v: version, interval: 8_000 });
    return;
  }

  if (!id || params.get('demo') === '1') {
    startDemo({
      onChat: (m) => view.add?.(m),
      onState: (st) => view.setState?.(st),
      platforms: () => ['youtube', 'kick'].filter((p) => view.s[p]),
    });
    return;
  }
  connectLive(`/api/w/${id}/poll`, {
    onHistory: (list) => view.setHistory?.(list),
    onChat: (m) => view.add?.(m),
    onDelete: (mid) => view.remove?.(mid),
    onState: (st) => view.setState?.(st),
    onSettings: ({ settings }) => view.setSettings(settingsFor({ ...DEFAULTS, ...settings })),
  }, { v: version, interval: type === 'stats' ? 10_000 : 4_000 });
}
// Inside OBS (Browser source): when "Start Streaming" is pressed, ask the server to look for the new stream right away,
// so the Discord announcement does not wait for the next check. Does nothing in a normal browser.
if (id && window.obsstudio) {
  let running = false;
  window.addEventListener('obsStreamingStarted', async () => {
    if (running) return;
    running = true;
    const ask = (event) => fetch(`/api/w/${id}/obs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event }) }).then((r) => (r.ok ? r.json() : { more: false }));
    let event = 'start';
    for (let i = 0; i < 36; i++) {
      let more = true;
      try { more = (await ask(event)).more; event = 'check'; } catch { /* offline for a moment: try again */ }
      if (!more) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    running = false;
  });
}
main().catch((e) => {
  const d = document.createElement('div');
  d.className = 'ow-error';
  d.textContent = e.message;
  app.replaceChildren(d);
});

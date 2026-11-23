import { DEFAULTS, decodeSettings } from '/js/settings.js';
import { ChatView, StatsView, EggsView } from '/js/render.js';
import { connectLive, startDemo, startEggDemo } from '/js/feed.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const id = (location.pathname.match(/^\/w\/([\w-]+)/) || [])[1];

async function main() {
  let type = ['stats', 'eggs'].includes(params.get('type')) ? params.get('type') : 'chat';
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
  const view = type === 'stats' ? new StatsView(app, s) : type === 'eggs' ? new EggsView(app, s) : new ChatView(app, s);
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
main().catch((e) => {
  const d = document.createElement('div');
  d.className = 'ow-error';
  d.textContent = e.message;
  app.replaceChildren(d);
});

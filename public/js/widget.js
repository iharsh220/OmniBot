import { DEFAULTS, decodeSettings } from '/js/settings.js';
import { ChatView, StatsView } from '/js/render.js';
import { connectLive, startDemo } from '/js/feed.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const id = (location.pathname.match(/^\/w\/([\w-]+)/) || [])[1];

async function main() {
  let type = params.get('type') === 'stats' ? 'stats' : 'chat';
  let base = DEFAULTS;
  if (id) {
    const r = await fetch(`/api/w/${id}`);
    if (!r.ok) throw new Error('Widget not found — copy the URL again from your OmniChat dashboard.');
    const cfg = await r.json();
    type = cfg.type;
    base = { ...DEFAULTS, ...cfg.settings };
  }
  // URL query params (optional) override the saved settings.
  const settingsFor = (b) => decodeSettings(location.search, b);
  const s = settingsFor(base);
  const view = type === 'stats' ? new StatsView(app, s) : new ChatView(app, s);

  if (!id || params.get('demo') === '1') {
    startDemo({
      onChat: (m) => view.add?.(m),
      onState: (st) => view.setState?.(st),
      platforms: () => ['youtube', 'kick'].filter((p) => view.s[p]),
    });
    return;
  }
  connectLive(`/api/w/${id}/events`, {
    onHistory: (list) => view.setHistory?.(list),
    onChat: (m) => view.add?.(m),
    onDelete: (mid) => view.remove?.(mid),
    onState: (st) => view.setState?.(st),
    onSettings: ({ settings }) => view.setSettings(settingsFor({ ...DEFAULTS, ...settings })),
  });
}
main().catch((e) => {
  const d = document.createElement('div');
  d.className = 'ow-error';
  d.textContent = e.message;
  app.replaceChildren(d);
});

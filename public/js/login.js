import { DEFAULTS, THEMES } from '/js/settings.js';
import { ChatView } from '/js/render.js';
import { startDemo } from '/js/feed.js';

const err = new URLSearchParams(location.search).get('error');
if (err) { const e = document.getElementById('error'); e.textContent = err; e.hidden = false; }

fetch('/api/providers').then((r) => r.json()).then((p) => {
  for (const k of ['youtube', 'kick']) if (!p[k]) {
    const b = document.getElementById('btn-' + k);
    b.classList.add('disabled');
    b.removeAttribute('href');
    b.title = 'Not configured on this server yet';
  }
}).catch(() => {});

const theme = THEMES.find((t) => t.id === 'glass');
const view = new ChatView(document.getElementById('demo'), { ...DEFAULTS, ...theme.values, fontSize: 13, maxMessages: 8 });
startDemo({ onChat: (m) => view.add(m) });

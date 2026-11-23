import { DEFAULTS, THEMES } from '/js/settings.js';
import { ChatView } from '/js/render.js';
import { startDemo } from '/js/feed.js';
import { hydrateIcons, bindThemeSwitch } from '/js/icons.js';

hydrateIcons();
bindThemeSwitch(document.getElementById('theme-switch'));

const err = new URLSearchParams(location.search).get('error');
if (err) {
  document.getElementById('error-text').textContent = err.slice(0, 300);
  document.getElementById('error').hidden = false;
  history.replaceState(null, '', '/login');
}

// Already signed in? Go straight to the dashboard.
fetch('/api/me', { credentials: 'same-origin' }).then((r) => { if (r.ok) location.replace('/'); }).catch(() => {});

// Streamlabs-style: remember the last login on this browser → one click "Continue as <name>".
function showLast(last, p) {
  const box = document.getElementById('last');
  if (!last || !p[last.provider]) { box.hidden = true; return; }
  const name = last.provider === 'youtube' ? 'YouTube' : 'Kick';
  const btn = document.getElementById('btn-last');
  btn.href = '/auth/' + last.provider;
  btn.classList.add(last.provider === 'youtube' ? 'yt-last' : 'kick-last');
  document.getElementById('last-label').textContent = last.name ? `Continue as ${last.name}` : `Continue with ${name}`;
  document.getElementById('last-sub').textContent = `Last signed in with ${name}`;
  const img = document.getElementById('last-avatar');
  if (last.avatar) { img.src = last.avatar; img.hidden = false; img.onerror = () => { img.hidden = true; }; }
  box.hidden = false;
}
document.getElementById('last-forget').addEventListener('click', () => {
  document.getElementById('last').hidden = true;
  fetch('/api/providers/forget', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
});

fetch('/api/providers', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.json()).then((p) => {
  showLast(p.last, p);
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

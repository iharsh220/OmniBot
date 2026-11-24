// Help & support page: message + up to 3 screenshots (pick, drop or paste) → /api/support.
const MAX_SHOTS = 3;
const MAX_BYTES = 2.8 * 1024 * 1024;

const readUrl = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(new Error('Could not read that file')); r.readAsDataURL(blob); });
/** Big screenshots are scaled down in the browser so they fit the upload limit. */
async function shrink(file) {
  if (file.size <= MAX_BYTES) return file;
  const img = await createImageBitmap(file);
  for (const side of [2400, 1600, 1100]) {
    const k = Math.min(1, side / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    if (out && out.size <= MAX_BYTES) return out;
  }
  throw new Error('That picture is too big (max 3 MB)');
}

export function createSupport({ $, h, ic, api, toast, ago, fmtTime, getPage }) {
  // The draft survives switching pages.
  const st = { category: '', message: '', email: '', shots: [], sending: false };

  async function add(files) {
    for (const file of [...files].filter((f) => f.type.startsWith('image/'))) {
      if (st.shots.length >= MAX_SHOTS) { toast(`Up to ${MAX_SHOTS} screenshots`, 'err'); return; }
      const shot = { id: null, url: '' };
      st.shots.push(shot);
      try {
        const blob = await shrink(file);
        shot.url = await readUrl(blob);
        drawShots();
        const r = await api('/api/support/shot', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        shot.id = r.id;
      } catch (e) {
        st.shots = st.shots.filter((x) => x !== shot);
        toast(e.message, 'err');
      }
      drawShots();
    }
  }
  function drawShots() {
    $('#sp-shots')?.replaceChildren(...st.shots.filter((s) => s.url).map((s) => h('div', { class: `sp-shot${s.id ? '' : ' busy'}` }, h('img', { src: s.url, alt: 'Screenshot' }),
      h('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove screenshot', onclick: () => { st.shots = st.shots.filter((x) => x !== s); drawShots(); } }, ic('x')))));
  }
  document.addEventListener('paste', (e) => {
    if (getPage() !== 'support') return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); add(files); }
  });

  async function send(btn) {
    if (st.sending) return;
    if (st.message.trim().length < 10) { toast('Please describe the problem (at least 10 characters)', 'err'); return; }
    if (st.shots.some((s) => !s.id)) { toast('Wait until the screenshots are uploaded', 'err'); return; }
    st.sending = true;
    btn.disabled = true;
    try {
      const r = await api('/api/support', { method: 'POST', body: JSON.stringify({ category: st.category, message: st.message, email: st.email.trim(), shots: st.shots.map((s) => s.id) }) });
      Object.assign(st, { message: '', shots: [] });
      toast(r.mailed ? `Sent to support (#${r.id})` : `Saved for support (#${r.id})`);
      show();
    } catch (e) { toast(e.message, 'err'); } finally { st.sending = false; btn.disabled = false; }
  }

  async function show() {
    let d;
    try { d = await api('/api/support'); } catch (e) { toast(e.message, 'err'); return; }
    if (getPage() !== 'support') return;
    st.category ||= d.categories[0];
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, onchange: (e) => { add(e.target.files); e.target.value = ''; } });
    const message = h('textarea', { class: 'input', maxlength: 3000, placeholder: 'What happened? What did you expect? Which page or widget?', oninput: (e) => { st.message = e.target.value; } });
    message.value = st.message;
    const drop = h('div', { class: 'sp-drop' }, h('button', { type: 'button', class: 'btn sm', onclick: () => input.click() }, ic('image'), 'Add screenshot'),
      h('span', { class: 'muted tiny' }, `Drop or paste (Ctrl/Cmd + V) also works · up to ${MAX_SHOTS} · hide private details`), input);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); });
    const btn = h('button', { type: 'button', class: 'btn primary', onclick: () => send(btn) }, ic('send'), 'Send to support');
    $('#page-support').replaceChildren(h('div', { class: 'sp-grid' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('help'), h('h3', {}, 'Report a problem')),
        h('div', { class: 'sp-form' },
          h('label', {}, 'Topic', h('select', { class: 'select', onchange: (e) => { st.category = e.target.value; } }, d.categories.map((c) => h('option', { value: c, selected: c === st.category }, c)))),
          h('label', {}, 'Message', message),
          drop, h('div', { class: 'sp-shots', id: 'sp-shots' }),
          h('label', {}, 'Your e-mail (optional, so we can reply)', h('input', { class: 'input', type: 'email', maxlength: 120, value: st.email, placeholder: 'you@example.com', autocomplete: 'email', oninput: (e) => { st.email = e.target.value; } })),
          h('div', {}, btn),
          h('span', { class: 'muted tiny' }, 'Your message, screenshots, IP address and device are sent to OmniChat support and kept 90 days.'))),
      h('div', { class: 'sp-side' },
        d.email ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('mail'), h('h3', {}, 'E-mail')), h('div', { class: 'sp-mail' }, h('a', { href: `mailto:${d.email}?subject=${encodeURIComponent('OmniChat support')}` }, d.email))) : null,
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('clock'), h('h3', {}, 'Your requests')),
          d.tickets.length ? h('ul', { class: 'ad-list' }, d.tickets.map((t) => h('li', {}, h('div', { class: 'txt', style: 'flex:1' }, h('b', {}, t.message), h('span', { title: fmtTime(t.ts) }, `#${t.id} · ${t.category} · ${ago(t.ts)}`)),
            h('span', { class: `tag ${t.status === 'resolved' ? 'ok' : 'warn'}` }, t.status === 'resolved' ? 'Resolved' : 'Open')))) : h('p', { class: 'muted tiny ad-pad' }, 'Nothing sent yet.')))));
    drawShots();
  }
  return { show };
}

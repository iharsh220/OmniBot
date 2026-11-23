// Public donation page /d/<uid>: UPI deep link (mobile) + QR (desktop) + "I've paid" note.
// The payment itself happens in the viewer's UPI app; this page never sees or handles money.
const root = document.getElementById('donate');
const uid = (location.pathname.match(/^\/d\/([\w-]{6,40})/) || [])[1];
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function fail(msg) { root.replaceChildren(el('h2', {}, 'Donations unavailable'), el('p', { class: 'muted' }, msg)); }

async function main() {
  if (!uid) return fail('This link is not complete. Ask the streamer for their donation link again.');
  const r = await fetch(`/api/donate/${uid}`);
  if (!r.ok) return fail('This streamer has not turned on donations yet.');
  const d = await r.json();
  document.title = `Support ${d.name} · OmniChat`;
  let amount = d.amounts[1] || d.amounts[0] || d.min;

  const linkFor = () => {
    const u = new URL(d.link.replace('upi://', 'https://x/'));
    if (amount) u.searchParams.set('am', Number(amount).toFixed(2));
    const who = nameIn.value.trim();
    u.searchParams.set('tn', `Stream donation${who ? ` from ${who}` : ''}`.slice(0, 60));
    return `upi://pay?${u.searchParams.toString()}`;
  };
  const chips = el('div', { class: 'donate-chips' });
  const custom = el('input', { class: 'input', type: 'number', min: d.min, max: 100000, step: 1, inputmode: 'numeric', placeholder: `Other amount (min ₹${d.min})`, 'aria-label': 'Amount in rupees' });
  const nameIn = el('input', { class: 'input', maxlength: 40, placeholder: 'Your name (shown on stream)', 'aria-label': 'Your name' });
  const msgIn = el('textarea', { class: 'input', maxlength: 200, rows: 2, placeholder: 'Message for the streamer (optional)', 'aria-label': 'Message' });
  const qr = el('img', { class: 'donate-qr', alt: 'UPI QR code', width: 220, height: 220 });
  const pay = el('a', { class: 'btn primary donate-pay' });
  const err = el('p', { class: 'donate-err', role: 'alert' });

  const refresh = () => {
    chips.replaceChildren(...d.amounts.map((a) => el('button', { type: 'button', class: `btn${a === amount ? ' on' : ''}`, onclick: () => { amount = a; custom.value = ''; refresh(); } }, `₹${a}`)));
    const ok = amount >= d.min;
    const link = linkFor();
    qr.src = `/api/qr.svg?d=${encodeURIComponent(link)}`;
    pay.href = ok ? link : '#';
    pay.textContent = ok ? `Pay ₹${amount} with UPI` : `Minimum is ₹${d.min}`;
    pay.classList.toggle('disabled', !ok);
  };
  custom.addEventListener('input', () => { const v = Math.round(Number(custom.value)); amount = v > 0 ? v : d.amounts[0]; refresh(); });
  nameIn.addEventListener('change', refresh);

  const copy = el('button', { type: 'button', class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(d.upi); copy.textContent = 'Copied ✓'; } catch { /* ignore */ } } }, 'Copy');
  const paid = el('button', { type: 'button', class: 'btn', onclick: async () => {
    err.textContent = '';
    if (!(amount >= d.min)) { err.textContent = `Minimum is ₹${d.min}`; return; }
    paid.disabled = true;
    try {
      const res = await fetch(`/api/donate/${uid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, name: nameIn.value, message: msgIn.value }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Could not send, please try again');
      root.replaceChildren(el('div', { class: 'donate-done' },
        el('div', { class: 'big' }, '💜'),
        el('h2', {}, 'Thank you!'),
        el('p', {}, `${d.name} will see your ₹${amount} donation note. Once they confirm the payment it can show on stream.`),
        el('div', { style: 'margin-top:22px;display:flex;justify-content:center;gap:10px' },
          el('button', {
            type: 'button', class: 'btn primary',
            onclick: () => {
              msgIn.value = '';
              custom.value = '';
              amount = d.amounts[1] || d.amounts[0] || d.min;
              paid.disabled = false;
              err.textContent = '';
              renderForm();
            }
          }, 'Send another donation / Pay again')
        )
      ));
    } catch (e) { err.textContent = e.message; paid.disabled = false; }
  } }, 'I’ve paid — tell the streamer');

  const head = el('div', { class: 'donate-head' },
    d.avatar && /^https:\/\//.test(d.avatar) ? el('img', { src: d.avatar, alt: '', referrerpolicy: 'no-referrer' }) : el('div', { class: 'ph' }, (d.name || '?')[0].toUpperCase()),
    el('div', {}, el('h1', {}, `Support ${d.name}`), el('p', { class: 'muted' }, d.text)));
  const qrBox = el('div', { class: 'donate-qrbox' }, qr, el('p', { class: 'muted tiny' }, isMobile ? 'Or scan from another phone' : 'Scan with any UPI app — GPay, PhonePe, Paytm, BHIM'));

  const renderForm = () => {
    root.replaceChildren(...[head,
      el('label', { class: 'donate-label' }, 'Amount'), chips, custom,
      el('label', { class: 'donate-label' }, 'Your name & message'), nameIn, msgIn,
      isMobile ? pay : null, qrBox, !isMobile ? pay : null,
      el('div', { class: 'donate-upi' }, el('span', { class: 'muted tiny' }, 'UPI ID'), el('b', {}, d.upi), copy),
      el('div', { class: 'donate-after' }, el('p', { class: 'muted tiny' }, 'After paying, press this so the streamer knows (they confirm it before it shows on stream):'), paid, err)].filter(Boolean));
    refresh();
  };
  renderForm();
}
main().catch(() => fail('Could not load. Please refresh the page.'));

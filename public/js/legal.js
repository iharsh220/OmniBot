// Privacy / Terms: show the support address (SUPPORT_EMAIL on the server) as the contact.
fetch('/api/providers').then((r) => r.json()).then((p) => {
  if (!p.supportEmail) return;
  for (const a of document.querySelectorAll('[data-support-email]')) { a.textContent = p.supportEmail; a.href = `mailto:${p.supportEmail}`; }
}).catch(() => {});

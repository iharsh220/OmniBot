// Discord page: announcements in the streamer's own server. No channel IDs: the bot's channels are found by themselves.
const TYPE_INFO = {
  live: ['YouTube live', 'radio', 'When you go live on YouTube'], video: ['YouTube video', 'play', 'When a new video is public'],
  short: ['YouTube Shorts', 'zap', 'When a new Short is public'], post: ['Posts', 'message', 'Posts you write on this page'], kick: ['Kick live', 'radio', 'When you go live on Kick'],
};
const MODE_LABEL = { off: 'Off', youtube: 'YouTube', kick: 'Kick', both: 'YouTube + Kick' };

export function createDiscord({ $, h, ic, api, toast, dialog, ago, fmtTime, ICONS, getPage }) {
  const post = { text: '', url: '', image: null, preview: '', sending: false }; // the draft survives switching pages
  const plat = (p) => h('span', { class: 'dc-plat', html: ICONS[p] });
  const toggle = (checked, onChange, label) => {
    const i = h('input', { type: 'checkbox', 'aria-label': label });
    i.checked = checked;
    i.addEventListener('change', () => onChange(i.checked));
    return h('label', { class: 'switch' }, i, h('span')); // a label: the visible part must pass the click on to the (hidden) checkbox
  };
  async function save(patch, msg = 'Saved') {
    try { await api('/api/discord', { method: 'PUT', body: JSON.stringify(patch) }); toast(msg); } catch (e) { toast(e.message, 'err'); }
    show();
  }
  async function run(btn, work) {
    btn.disabled = true;
    try { await work(); } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
  }
  const button = (cls, icon, label, work) => { const b = h('button', { type: 'button', class: cls, onclick: () => run(b, work) }, ic(icon), label); return b; };

  function serverCard(d) {
    if (!d.server) {
      return h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('discord'), h('h3', {}, 'Add OmniChat to your Discord')),
        h('div', { class: 'dc-empty' },
          d.error ? h('div', { class: 'notice warn' }, ic('alert'), h('div', {}, d.error)) : null,
          h('p', {}, 'Pick your server on Discord’s own page. OmniChat then posts in the channels you add the bot to.'),
          d.canInvite ? h('a', { class: 'btn primary', href: '/auth/discord' }, ic('discord'), 'Add to Discord') : h('p', { class: 'muted' }, 'The OmniChat bot is not in your server yet.')));
    }
    const mode = (c) => {
      const sel = h('select', { class: 'select', 'aria-label': `What to post in ${c.name}`, onchange: (e) => save({ modes: { [c.id]: e.target.value } }) },
        h('option', { value: 'auto', selected: !c.chosen }, `Auto (${MODE_LABEL[c.auto]})`), Object.entries(MODE_LABEL).map(([v, l]) => h('option', { value: v, selected: c.chosen && c.mode === v }, l)));
      return sel;
    };
    const add = d.others.length ? h('select', { class: 'select', 'aria-label': 'Add a channel', onchange: (e) => { if (e.target.value) save({ modes: { [e.target.value]: 'both' } }, 'Channel added'); } },
      h('option', { value: '' }, 'Use another channel…'), d.others.map((c) => h('option', { value: c.id }, `#${c.name}`))) : null;
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, ic('discord'), h('h3', {}, d.server.name), h('span', { class: `tag ${d.settings.enabled ? 'ok' : ''}` }, d.settings.enabled ? 'ON' : 'OFF'),
        h('div', { class: 'actions' }, toggle(d.settings.enabled, (v) => save({ enabled: v }, v ? 'Announcements ON' : 'Announcements OFF'), 'Announcements'))),
      d.error ? h('div', { class: 'notice warn dc-notice' }, ic('alert'), h('div', {}, d.error)) : null,
      d.channels.length ? d.channels.map((c) => h('div', { class: 'srow dc-chan' }, h('div', { class: 'txt' }, h('b', {}, `#${c.name}`, ' ', c.mode === 'off' ? null : [c.mode !== 'kick' ? plat('youtube') : null, c.mode !== 'youtube' ? plat('kick') : null]),
        c.missing.length && c.mode !== 'off' ? h('span', { class: 'dc-bad' }, `The bot still needs: ${c.missing.join(', ')}`) : h('span', {}, c.chosen ? 'Chosen by you' : 'Found automatically')), mode(c)))
        : h('p', { class: 'dc-empty muted' }, 'No channel yet. In Discord open a channel → Edit Channel → Permissions → add the OmniChat bot. It shows up here by itself (names with “youtube” or “kick” are recognised).'),
      h('div', { class: 'dc-add' }, h('span', { class: 'muted tiny' }, 'A channel the bot is added to appears here automatically.'), h('div', { class: 'dc-row' }, add, button('btn sm ghost', 'refresh', 'Refresh', show))),
      d.canInvite && !d.server.auto ? h('div', { class: 'srow' }, h('div', { class: 'txt' }, h('span', {}, 'Stop announcing in this server.')), button('btn sm ghost danger', 'trash', 'Disconnect', async () => {
        if (!(await dialog({ title: 'Disconnect this server?', text: 'OmniChat stops posting there. You can also remove the bot in Discord.', confirm: 'Disconnect', danger: true }))) return;
        await api('/api/discord/link', { method: 'DELETE' });
        toast('Disconnected');
        show();
      })) : null);
  }

  function typesCard(d) {
    const pingState = (ping, tag) => {
      const hasEv = ping === 'both' || ping === 'everyone';
      const hasHr = ping === 'both' || ping === 'here';
      const ev = tag === 'everyone' ? !hasEv : hasEv;
      const hr = tag === 'here' ? !hasHr : hasHr;
      return ev && hr ? 'both' : ev ? 'everyone' : hr ? 'here' : 'none';
    };
    const roleMap = new Map((d.roles || []).map((r) => [r.id, r]));
    const summaryOf = (s) => {
      const out = [];
      if (s.ping === 'both' || s.ping === 'everyone') out.push('@everyone');
      if (s.ping === 'both' || s.ping === 'here') out.push('@here');
      for (const id of s.roles || []) {
        const r = roleMap.get(id);
        out.push(r ? `@${r.name}` : '@deleted-role');
      }
      return out.length ? out.join(', ') : 'No ping';
    };
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('bell'), h('h3', {}, 'What gets announced')),
      Object.entries(TYPE_INFO).filter(([t]) => (t === 'kick' ? d.kick : t === 'post' || d.youtube)).map(([t, [label, icon, sub]]) => {
        const s = d.settings.types[t];
        const selRoles = Array.isArray(s.roles) ? s.roles : [];
        const hasAny = s.ping !== 'none' || selRoles.length > 0;
        const text = t === 'post' ? null : h('input', { class: 'input', value: s.text, maxlength: 300, placeholder: d.defaults[t], 'aria-label': `${label} message`, onchange: (e) => save({ types: { [t]: { text: e.target.value } } }) });
        const evOn = s.ping === 'both' || s.ping === 'everyone';
        const hrOn = s.ping === 'both' || s.ping === 'here';
        const tagBtn = (name, on, color, onClick) => h('button', {
          type: 'button',
          class: `dc-tag${on ? ' on' : ''}`,
          'aria-pressed': String(on),
          onclick: onClick,
        }, color ? h('span', { class: 'dc-tag-dot', style: `background:${color}` }) : null, name);
        return h('div', { class: 'dc-type' },
          h('div', { class: 'dc-type-head' }, ic(icon), h('div', { class: 'txt' }, h('b', {}, label), h('span', {}, sub)),
            button('btn sm', 'send', 'Send test', async () => { const r = await api('/api/discord/test', { method: 'POST', body: JSON.stringify({ type: t }) }); toast(`Test sent to ${r.channels.map((c) => `#${c}`).join(', ')}`); }),
            toggle(s.on, (v) => save({ types: { [t]: { on: v } } }), label)),
          h('div', { class: 'dc-tags-wrap' },
            h('div', { class: 'dc-tags-head' },
              h('span', { class: 'muted tiny' }, 'Tags: ', h('strong', {}, summaryOf(s))),
              hasAny ? h('button', { type: 'button', class: 'dc-tag-clear', onclick: () => save({ types: { [t]: { ping: 'none', roles: [] } } }) }, 'Clear') : null),
            h('div', { class: 'dc-tags', role: 'group', 'aria-label': `${label} tags` },
              tagBtn('@everyone', evOn, null, () => save({ types: { [t]: { ping: pingState(s.ping, 'everyone') } } })),
              tagBtn('@here', hrOn, null, () => save({ types: { [t]: { ping: pingState(s.ping, 'here') } } })),
              (d.roles || []).map((r) => {
                const on = selRoles.includes(r.id);
                const nextRoles = on ? selRoles.filter((id) => id !== r.id) : [...selRoles, r.id];
                return tagBtn(`@${r.name}`, on, r.color, () => save({ types: { [t]: { roles: nextRoles } } }));
              }))),
          text);
      }),
      h('p', { class: 'muted tiny dc-foot' }, 'In the message {name} and {title} are filled in. A test pings exactly like the real thing. Live cards update themselves: picture, viewers, and a short report when the stream ends (edits never ping again).'));
  }

  function postCard() {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    const text = h('textarea', { class: 'input', maxlength: 1800, placeholder: 'Write your post…', oninput: (e) => { post.text = e.target.value; } });
    text.value = post.text;
    const url = h('input', { class: 'input', value: post.url, placeholder: 'Link (optional, https://…)', oninput: (e) => { post.url = e.target.value; } });
    const drop = async () => { const id = post.image; Object.assign(post, { image: null, preview: '' }); if (id) api(`/api/media/${id}`, { method: 'DELETE' }).catch(() => {}); show(); };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024) { toast('Picture is too big (max 3 MB)', 'err'); return; }
      try {
        const r = await api('/api/media?kind=image', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        Object.assign(post, { image: r.id, preview: r.url });
        show();
      } catch (e) { toast(e.message, 'err'); }
    });
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('message'), h('h3', {}, 'Write a post'), h('span', { class: 'sub' }, 'YouTube community posts can’t be read by apps, so send them from here')),
      h('div', { class: 'dc-post' }, text, url,
        post.preview ? h('div', { class: 'dc-pic' }, h('img', { src: post.preview, alt: 'Picture' }), h('button', { type: 'button', class: 'btn sm ghost', onclick: drop }, ic('trash'), 'Remove')) : null,
        h('div', { class: 'dc-row' }, h('button', { type: 'button', class: 'btn sm', onclick: () => input.click() }, ic('image'), 'Picture'), input,
          button('btn primary', 'send', 'Send to Discord', async () => {
            const r = await api('/api/discord/post', { method: 'POST', body: JSON.stringify({ text: post.text, url: post.url.trim(), image: post.image }) });
            toast(r.result === 'already' ? 'Already sent a moment ago' : 'Posted on Discord');
            Object.assign(post, { text: '', url: '', image: null, preview: '' });
            show();
          }))));
  }

  function liveCard(d) {
    const go = (platform, label) => button('btn', 'radio', label, async () => {
      if (!(await dialog({ title: `${label}?`, text: 'The live announcement (with its ping) is posted right now. The automatic one is skipped for this stream.', confirm: 'Announce now' }))) return;
      const r = await api('/api/discord/live', { method: 'POST', body: JSON.stringify({ platform }) });
      toast({ sent: 'Announced', already: 'Already announced', off: 'This announcement is switched off' }[r.result] || r.result);
      show();
    });
    const li = (ok, title, sub) => h('li', { class: ok ? 'done' : '' }, h('span', { class: 'check' }, ic(ok ? 'check' : 'info')), h('div', { class: 'txt' }, h('b', {}, title), h('span', {}, sub)));
    const cronOk = d.cron.lastAt && Date.now() - d.cron.lastAt < 20 * 60_000;
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('radio'), h('h3', {}, 'Go live')),
      h('div', { class: 'dc-row dc-go' }, d.youtube ? go('youtube', 'YouTube live now') : null, d.kick ? go('kick', 'Kick live now') : null),
      h('ul', { class: 'checklist' },
        d.youtube ? li(!!d.obsAt, 'OBS start signal', d.obsAt ? `Last heard ${ago(d.obsAt)}` : 'Not heard yet. Keep an OmniChat overlay in OBS; “Shutdown source when not visible” must be OFF') : null,
        d.kick ? li(d.push.possible, 'Kick', d.push.possible ? 'Kick tells OmniChat directly' : 'Works after deploy (needs a public address)') : null,
        d.youtube ? li(d.push.on, 'New videos (YouTube push)', d.push.on ? 'Active' : d.push.possible ? 'Starts a moment after you switch announcements ON' : 'Works after deploy (needs a public address)') : null,
        li(cronOk, '1-minute backup check', cronOk ? `Last run ${ago(d.cron.lastAt)}` : d.cron.configured ? 'Waiting for the scheduler' : 'Not set up on the server (CRON_SECRET)')));
  }

  function historyCard(d) {
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('clock'), h('h3', {}, 'Sent')),
      d.history.length ? h('ul', { class: 'ad-list' }, d.history.map((x) => h('li', {}, h('span', { class: `ad-dot ${x.ok ? 'ok' : 'error'}` }), h('div', { class: 'txt' },
        h('b', {}, x.title || (TYPE_INFO[x.type] || [x.type])[0]),
        h('span', { title: fmtTime(x.ts) }, [(TYPE_INFO[x.type] || [x.type])[0], x.channel ? `#${x.channel}` : null, x.source, ago(x.ts), x.late !== null ? `${x.late}s after start` : null].filter(Boolean).join(' · ')),
        x.error ? h('span', { class: 'dc-bad' }, x.error) : null)))) : h('p', { class: 'muted tiny ad-pad' }, 'Nothing announced yet.'));
  }

  async function show() {
    const root = $('#page-discord');
    if (!root.children.length) root.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    let d;
    try { d = await api('/api/discord'); } catch (e) { root.replaceChildren(h('div', { class: 'notice warn' }, ic('alert'), h('div', {}, e.message))); return; }
    if (getPage() !== 'discord') return;
    root.replaceChildren(!d.server ? serverCard(d) : h('div', { class: 'grid two' },
      h('div', { class: 'grid', style: 'align-content:start' }, serverCard(d), typesCard(d)),
      h('div', { class: 'grid', style: 'align-content:start' }, liveCard(d), postCard(), historyCard(d))));
  }
  return { show };
}

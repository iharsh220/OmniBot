// Admin panel (OmniChat Bot account only). The server checks the account on every /api/admin request;
// hiding these pages for everyone else is only cosmetic.
export const ADMIN_PAGES = {
  admin: ['Admin overview', 'Everything happening on OmniChat'],
  streamers: ['Streamers', 'Everyone who signed in: when, from where, and what they use'],
  activity: ['Activity', 'Every sign-in and action, newest first'],
  issues: ['Issues', 'Failed sign-ins, server and browser errors, platform problems'],
  discordlog: ['Discord', 'Servers, announcements and their problems'],
  tickets: ['Support requests', 'Messages and screenshots sent by streamers'],
};
const PLATFORM = { youtube: 'YouTube', kick: 'Kick' };
const KINDS = {
  auth: ['Sign-in', 'key'], account: ['Account', 'plug'], widget: ['Widgets', 'layout'], eggs: ['Egg Bot', 'egg'], tools: ['Live tools', 'zap'],
  donate: ['Donations', 'heart'], media: ['Uploads', 'upload'], support: ['Support', 'help'], discord: ['Discord', 'discord'], settings: ['Settings', 'settings'], page: ['Page', 'eye'], other: ['Other', 'info'],
};
const ISSUE_KINDS = {
  login: ['Failed sign-in', 'lock'], server: ['Server error', 'database'], browser: ['Browser error', 'monitor'], youtube: ['YouTube', 'radio'], kick: ['Kick', 'radio'],
  eggs: ['Egg Bot', 'egg'], bot: ['Chat bot', 'message'], auth: ['Login', 'key'], access: ['Access denied', 'shield'], system: ['System', 'settings'], mail: ['Support e-mail', 'mail'], discord: ['Discord', 'discord'],
};

export function createAdmin({ $, h, ic, api, toast, ago, fmtN, fmtTime, exportCsv, ICONS, getPage }) {
  const ui = { users: [], q: '', filter: '', sort: 'new', tab: 'activity', timer: null, seq: 0 };
  const lists = { activity: { q: '', kind: '' }, issues: { q: '', kind: '' } };

  // ── small pieces ──
  const avatar = (u, cls = '') => {
    const letter = (u?.name || '?')[0].toUpperCase();
    const el = h('span', { class: `ad-av ${cls}` });
    if (!u?.avatar) { el.textContent = letter; return el; }
    el.append(h('img', { src: u.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: () => { el.textContent = letter; } }));
    return el;
  };
  const plat = (p) => h('span', { class: 'ad-plat', title: PLATFORM[p], html: ICONS[p] });
  const place = (l) => {
    if (!l) return null;
    let country = l.country;
    try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of(l.country) || l.country; } catch { /* unknown code */ }
    return [l.city, l.region && !/^\d+$/.test(l.region) ? l.region : null, country].filter(Boolean).join(', ') || null;
  };
  const when = (ts) => (ts ? h('span', { title: fmtTime(ts) }, ago(ts)) : h('span', { class: 'muted' }, '—'));
  const fullTime = (ts) => (ts ? new Date(ts).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const whenTd = (ts) => h('td', { class: 'when', title: fmtTime(ts) }, h('b', {}, ago(ts)), fullTime(ts));
  const tag = (t, cls = '') => h('span', { class: `tag ${cls}` }, t);
  const kindTag = (map, k) => h('span', { class: 'ad-kind' }, ic((map[k] || ['', 'info'])[1]), (map[k] || [k])[0]);
  const person = (r) => (r.uid
    ? h('a', { class: 'ad-person', href: `#streamers/${r.uid}` }, avatar(r), h('b', {}, r.name || 'Deleted user'))
    : h('span', { class: 'muted' }, r.kind === 'account' ? 'Deleted user' : 'Not signed in'));
  const from = (r) => h('div', { class: 'ad-from' }, h('code', {}, r.ip || '—'), h('span', {}, place(r.loc) || 'Location unknown'), r.device ? h('span', {}, r.device) : null);
  const empty = (icon, title, text) => h('div', { class: 'empty' }, ic(icon), h('b', {}, title), text);
  const table = (heads, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, heads.map((x) => h('th', {}, x)))), h('tbody', {}, rows)));
  const fact = (label, val) => h('div', { class: 'ad-fact' }, h('span', {}, label), h('b', {}, val ?? '—'));
  const failTag = (r) => (r.ok === false ? tag(`Failed${r.status ? ` ${r.status}` : ''}`, 'bad') : null);

  const actionRow = (r, who = true) => h('tr', {}, whenTd(r.ts), who ? h('td', {}, person(r)) : null, h('td', {}, kindTag(KINDS, r.kind)),
    h('td', { class: 'msgc' }, h('b', {}, r.action), ' ', failTag(r), r.detail ? h('span', { class: 'ad-detail' }, r.detail) : null), h('td', {}, from(r)));
  const issueRow = (r, who = true) => h('tr', {}, whenTd(r.ts), who ? h('td', {}, person(r)) : null,
    h('td', {}, kindTag(ISSUE_KINDS, r.kind), ' ', tag(r.level, r.level === 'error' ? 'bad' : 'warn')),
    h('td', { class: 'msgc' }, h('b', {}, r.message), r.where ? h('span', { class: 'ad-detail mono' }, r.where) : null, h('span', { class: 'ad-detail' }, `Ref ${r.id}`)),
    h('td', {}, r.ip ? from(r) : h('span', { class: 'muted tiny' }, 'Background task')));
  const HEAD = { activity: ['When', 'Streamer', 'Type', 'What', 'From'], issues: ['When', 'Streamer', 'Type', 'Problem', 'From'] };

  /** Run a page's loader; ignore the result if the admin already moved on. */
  async function load(pageId, path, render) {
    const seq = ++ui.seq;
    try {
      const d = await api(path);
      if (seq === ui.seq && getPage() === pageId) render(d);
    } catch (e) {
      if (seq !== ui.seq || getPage() !== pageId) return;
      const root = $(`#page-${pageId}`);
      if (!root.children.length) root.replaceChildren(h('div', { class: 'card' }, empty('alert', 'Could not load this page', e.message)));
      else toast(e.message, 'err');
    }
  }

  // ── Overview ──
  const loadOverview = () => load('admin', '/api/admin/overview', (d) => {
    const t = d.totals;
    badge(t.openTickets);
    const kpi = (icon, label, val, foot, href) => h(href ? 'a' : 'div', { class: 'card kpi ad-kpi', href }, h('div', { class: 'kpi-top' }, h('div', { class: 'kpi-ic' }, ic(icon)), label), h('div', { class: 'kpi-val' }, fmtN(val)), h('div', { class: 'kpi-foot' }, foot));
    const sys = (ok, title, sub, action) => h('li', { class: ok ? 'done' : '' }, h('span', { class: 'check' }, ic(ok ? 'check' : 'alert')), h('div', { class: 'txt' }, h('b', {}, title), h('span', {}, sub)), action);
    const s = d.system;
    const more = (href) => h('div', { class: 'actions' }, h('a', { class: 'btn sm ghost', href }, 'View all'));
    $('#page-admin').replaceChildren(
      h('div', { class: 'grid kpis' },
        kpi('users', 'Streamers', t.users, `${t.new7d} new this week`, '#streamers'),
        kpi('eye', 'Active now', t.activeNow, `${t.active24h} in 24h · ${t.overlays} overlay${t.overlays === 1 ? '' : 's'} running`, '#streamers'),
        kpi('radio', 'Live now', t.live, `${t.youtube} YouTube · ${t.kick} Kick · ${t.eggBot} Egg Bot ON`, '#streamers'),
        kpi('alert', 'Errors · 24h', t.errors24h, `${t.failedLogins24h} failed sign-in${t.failedLogins24h === 1 ? '' : 's'}`, '#issues'),
        kpi('key', 'Signed in · 24h', t.signedIn24h, 'Different streamers', '#activity'),
        kpi('help', 'Support requests', t.openTickets, 'Waiting for an answer', '#tickets'),
        kpi('plug', 'Need reconnect', t.problems, 'YouTube or Kick login expired', '#streamers')),
      h('div', { class: 'grid two', style: 'margin-top:16px' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('clock'), h('h3', {}, 'Latest activity'), more('#activity')),
          d.recent.length ? table(HEAD.activity, d.recent.map((r) => actionRow(r))) : empty('clock', 'No activity yet', 'Sign-ins and actions show up here from now on.')),
        h('div', { class: 'grid', style: 'align-content:start' },
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('shield'), h('h3', {}, 'System')),
            h('ul', { class: 'checklist' },
              sys(s.ytBot.ok, 'YouTube bot', s.ytBot.ok ? `Posting as ${s.ytBot.name}` : 'Not ready', s.ytBot.ok ? null : h('a', { class: 'btn sm', href: '#eggs' }, 'Fix')),
              sys(s.kickBot.ok, 'Kick bot', s.kickBot.ok ? `Posting as ${s.kickBot.name}` : 'Not ready', s.kickBot.ok ? null : h('a', { class: 'btn sm', href: '#eggs' }, 'Fix')),
              sys(s.discord.ok, 'Discord egg feed', s.discord.error || (s.discord.lastCheckAt ? `Checked ${ago(s.discord.lastCheckAt)}` : 'Not started')),
              sys(s.mail.ok, 'Support e-mail', s.mail.ok ? `Requests go to ${s.mail.address}` : 'SUPPORT_EMAIL / SMTP_PASS missing in Vercel. Requests are only saved here.'),
              sys(s.store === 'kv', 'Storage', s.store === 'kv' ? 'Upstash Redis' : `${s.store} (not production)`))),
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('radio'), h('h3', {}, 'Live now')),
            d.liveNow.length ? h('ul', { class: 'ad-list' }, d.liveNow.map((u) => h('li', {}, avatar(u), h('div', { class: 'txt' }, h('a', { href: `#streamers/${u.id}` }, u.name),
              h('span', {}, u.accounts.filter((a) => a.live).map((a) => `${PLATFORM[a.provider]}: ${fmtN(a.viewers)} watching`).join(' · ')))))) : h('p', { class: 'muted tiny ad-pad' }, 'Nobody is live.')),
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('alert'), h('h3', {}, 'Latest issues'), more('#issues')),
            d.issues.length ? h('ul', { class: 'ad-list' }, d.issues.map((r) => h('li', {}, h('span', { class: `ad-dot ${r.level}` }), h('div', { class: 'txt' }, h('b', {}, r.message), h('span', {}, [r.name, ago(r.ts)].filter(Boolean).join(' · '))))))
              : h('p', { class: 'muted tiny ad-pad' }, 'No problems recorded.')))),
      h('p', { class: 'muted tiny ad-note' }, ic('info'), `Activity, IPs and issues are kept ${d.keepDays} days. Location is approximate (from the IP address).`));
  });

  // ── Streamers ──
  const FILTERS = [['', 'All'], ['active', 'Active now'], ['live', 'Live'], ['problem', 'Need reconnect'], ['idle', 'Inactive 30d']];
  const SORTS = [['new', 'Newest account'], ['seen', 'Last active'], ['login', 'Last sign-in'], ['name', 'Name']];
  const match = {
    '': () => true, active: (u) => u.active, live: (u) => u.live, problem: (u) => u.problem,
    idle: (u) => Date.now() - (u.lastSeenAt || u.lastLoginAt || u.createdAt || 0) > 30 * 86_400_000,
  };
  function shownUsers() {
    const q = ui.q.toLowerCase();
    const text = (u) => [u.name, u.id, u.ip, place(u.loc), u.device, ...u.accounts.flatMap((a) => [a.channelName, a.channelSlug, a.channelId])].filter(Boolean).join(' ').toLowerCase();
    const by = { new: (u) => -(u.createdAt || 0), seen: (u) => -(u.lastSeenAt || 0), login: (u) => -(u.lastLoginAt || 0) };
    return ui.users.filter((u) => match[ui.filter](u) && (!q || text(u).includes(q)))
      .sort((a, b) => (ui.sort === 'name' ? String(a.name).localeCompare(String(b.name)) : by[ui.sort](a) - by[ui.sort](b)));
  }
  const status = (u) => [u.isBot ? tag('Bot', 'purple') : null, u.live ? tag('LIVE', 'live') : null, u.active ? tag('Active', 'ok') : null, u.problem ? tag('Reconnect', 'warn') : null].filter(Boolean);
  function fillUsers() {
    const box = $('#ad-users');
    if (!box) return;
    const rows = shownUsers();
    $('#ad-count').textContent = `${rows.length} of ${ui.users.length}`;
    box.replaceChildren(rows.length ? table(['Streamer', 'Channels', 'Joined', 'Last sign-in', 'Last active', 'From', 'Status'], rows.map((u) => h('tr', { class: 'ad-click', onclick: (e) => { if (!e.target.closest('a')) location.hash = `streamers/${u.id}`; } },
      h('td', {}, h('a', { class: 'ad-person', href: `#streamers/${u.id}` }, avatar(u), h('b', {}, u.name || 'Unnamed'))),
      h('td', {}, u.accounts.map((a) => h('div', { class: 'ad-chan' }, plat(a.provider), a.channelName))),
      h('td', { class: 'ad-nowrap' }, fullTime(u.createdAt)),
      h('td', { class: 'ad-nowrap' }, u.lastLoginAt ? [when(u.lastLoginAt), h('span', { class: 'ad-detail' }, `${u.loginCount} sign-in${u.loginCount === 1 ? '' : 's'}`)] : h('span', { class: 'muted' }, 'Not recorded yet')),
      h('td', { class: 'ad-nowrap' }, when(u.lastSeenAt)),
      h('td', {}, u.ip ? from(u) : h('span', { class: 'muted' }, '—')),
      h('td', {}, h('div', { class: 'ad-tags' }, status(u)))))) : empty('users', 'No streamers found', 'Try another search or filter.'));
  }
  function renderUsers() {
    const search = h('div', { class: 'input-icon search' }, ic('search'), h('input', { class: 'input', type: 'search', placeholder: 'Name, channel, IP, city…', value: ui.q, maxlength: 100, 'aria-label': 'Search streamers', oninput: (e) => { ui.q = e.target.value; fillUsers(); } }));
    const seg = h('div', { class: 'seg' }, FILTERS.map(([v, l]) => h('button', { type: 'button', class: v === ui.filter ? 'on' : '', onclick: () => { ui.filter = v; renderUsers(); } }, l)));
    const sort = h('select', { class: 'select', style: 'width:auto', 'aria-label': 'Sort by', onchange: (e) => { ui.sort = e.target.value; fillUsers(); } }, SORTS.map(([v, l]) => h('option', { value: v, selected: v === ui.sort }, l)));
    const csv = () => exportCsv('omnichat-streamers', ['name', 'user id', 'channels', 'joined', 'last sign-in', 'sign-ins', 'last active', 'ip', 'location', 'device', 'egg bot', 'widgets'], shownUsers().map((u) => [u.name, u.id,
      u.accounts.map((a) => `${PLATFORM[a.provider]}: ${a.channelName} (${a.channelId})`).join(' | '), ...[u.createdAt, u.lastLoginAt].map((x) => (x ? new Date(x).toISOString() : '')), u.loginCount,
      u.lastSeenAt ? new Date(u.lastSeenAt).toISOString() : '', u.ip || '', place(u.loc) || '', u.device || '', u.eggBot ? 'ON' : 'OFF', u.widgets]));
    $('#page-streamers').replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'logbar' }, search, seg, sort, h('div', { class: 'spacer' }), h('span', { class: 'tiny muted', id: 'ad-count' }), h('button', { class: 'btn sm', type: 'button', onclick: csv }, ic('download'), 'Export CSV')),
      h('div', { id: 'ad-users' })));
    fillUsers();
  }
  const loadUsers = () => load('streamers', '/api/admin/users', (d) => { ui.users = d.users; if ($('#ad-users')) fillUsers(); else renderUsers(); });

  // ── One streamer ──
  const loadUser = (id) => load('streamers', `/api/admin/users/${encodeURIComponent(id)}`, (d) => {
    const u = d.user;
    const link = (a) => (a.provider === 'youtube' ? `https://www.youtube.com/channel/${encodeURIComponent(a.channelId)}` : a.channelSlug ? `https://kick.com/${encodeURIComponent(a.channelSlug)}` : null);
    const tabs = {
      activity: ['Activity', 'clock', d.activity.length, () => (d.activity.length ? table(['When', 'Type', 'What', 'From'], d.activity.map((r) => actionRow(r, false))) : empty('clock', 'Nothing recorded yet', 'Actions appear here the next time this streamer uses OmniChat.'))],
      ips: ['IPs & devices', 'monitor', d.ips.length, () => (d.ips.length ? table(['IP', 'Location', 'Device', 'First seen', 'Last seen'], d.ips.map((x) => h('tr', {}, h('td', {}, h('code', {}, x.ip || '—')), h('td', {}, place(x.loc) || 'Unknown'), h('td', {}, x.device || '—'), h('td', { class: 'ad-nowrap' }, fullTime(x.first)), h('td', { class: 'ad-nowrap' }, fullTime(x.last))))) : empty('monitor', 'No IPs recorded yet', ''))],
      issues: ['Issues', 'alert', d.issues.length, () => (d.issues.length ? table(['When', 'Type', 'Problem', 'From'], d.issues.map((r) => issueRow(r, false))) : empty('check', 'No problems', 'Nothing went wrong for this streamer.'))],
      logs: ['System logs', 'logs', d.logs.length, () => (d.logs.length ? table(['When', 'Level', 'Source', 'Message'], d.logs.map((l) => h('tr', {}, whenTd(l.ts), h('td', {}, h('span', { class: `lvl ${l.level}` }, l.level)), h('td', {}, l.source), h('td', { class: 'msgc' }, l.message)))) : empty('logs', 'No system logs', 'Kept 14 days.'))],
      discord: ['Discord', 'discord', d.discord?.history.length || 0, () => (!d.discord ? empty('discord', 'No Discord server', 'This streamer has not connected Discord.') : h('div', {},
        h('div', { class: 'ad-facts' }, fact('Server', d.discord.server), fact('Announcements', d.discord.enabled ? 'ON' : 'OFF'), fact('Last post', fullTime(d.discord.lastAt)), fact('Last start signal', fullTime(d.discord.obsAt)),
          ...Object.entries(d.discord.types).map(([t, p]) => fact(DTYPE[t] || t, { both: '@everyone + @here', everyone: '@everyone', here: '@here', none: 'No ping', off: 'Off' }[p] || p))),
        d.discord.history.length ? table(SENT_HEAD.filter((x) => x !== 'Streamer'), d.discord.history.map((x) => sentRow(x, false))) : null))],
      widgets: ['Widgets', 'layout', d.widgets.length, () => table(['Type', 'Name', 'Created', 'Last edited'], d.widgets.map((w) => h('tr', {}, h('td', {}, w.type), h('td', {}, w.name), h('td', {}, fullTime(w.createdAt)), h('td', {}, fullTime(w.updatedAt)))))],
    };
    const csv = () => exportCsv(`omnichat-${u.name || u.id}`, ['time', 'type', 'action', 'detail', 'result', 'ip', 'location', 'device'], d.activity.map((r) => [new Date(r.ts).toISOString(), r.kind, r.action, r.detail || '', r.ok === false ? 'failed' : 'ok', r.ip || '', place(r.loc) || '', r.device || '']));
    const card = h('div', { class: 'card' });
    const draw = () => card.replaceChildren(
      h('div', { class: 'logbar' }, h('div', { class: 'seg ad-tabs', role: 'tablist' }, Object.entries(tabs).map(([k, [label, icon, n]]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === ui.tab), class: k === ui.tab ? 'on' : '', onclick: () => { ui.tab = k; draw(); } }, ic(icon), label, h('span', { class: 'n' }, String(n))))),
        h('div', { class: 'spacer' }), h('button', { class: 'btn sm', type: 'button', onclick: csv }, ic('download'), 'Export activity')),
      tabs[ui.tab][3]());
    draw();
    $('#page-streamers').replaceChildren(
      h('a', { class: 'btn sm ghost ad-back', href: '#streamers' }, ic('back'), 'All streamers'),
      h('div', { class: 'card ad-profile' }, avatar(u, 'lg'),
        h('div', { class: 'ad-profile-main' }, h('div', { class: 'ad-profile-name' }, h('h2', {}, u.name || 'Unnamed'), status(u)), h('span', { class: 'muted tiny' }, `User ID ${u.id}`)),
        h('button', { class: 'btn sm', type: 'button', onclick: () => loadUser(id) }, ic('refresh'), 'Refresh')),
      h('div', { class: 'grid cols-2', style: 'margin:16px 0' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('info'), h('h3', {}, 'Account')),
          h('div', { class: 'ad-facts' }, fact('Joined', fullTime(u.createdAt)), fact('Last sign-in', u.lastLoginAt ? `${fullTime(u.lastLoginAt)} (${u.loginCount} total)` : 'Not recorded yet'),
            fact('Last active', fullTime(u.lastSeenAt)), fact('Overlay last used', fullTime(u.overlayAt)), fact('Last IP', u.ip), fact('Location', place(u.loc)), fact('Device', u.device),
            fact('Signed-in devices', u.sessions), fact('Egg Bot', u.eggBot ? `ON · ${d.eggPostsToday} YouTube posts today` : 'OFF'), fact('Commands / timers', `${d.tools.commands} / ${d.tools.timers}`),
            fact('Donations page', u.donations ? 'ON' : 'OFF'), fact('Chat history', u.historyDays ? `${u.historyDays} days` : 'Off'))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('plug'), h('h3', {}, 'Channels')),
          u.accounts.length ? u.accounts.map((a) => h('div', { class: 'srow' }, avatar({ name: a.channelName, avatar: a.avatar }), h('div', { class: 'txt' },
            h('b', {}, plat(a.provider), ' ', a.channelName), h('span', {}, [a.channelSlug, `connected ${fullTime(a.connectedAt)}`].filter(Boolean).join(' · ')),
            h('span', { class: 'ad-detail mono' }, a.channelId), a.error ? h('span', { class: 'ad-err' }, a.error) : null),
          a.live ? tag(`LIVE · ${fmtN(a.viewers)}`, 'live') : a.reconnect ? tag('Reconnect needed', 'warn') : tag('Connected', 'ok'),
          link(a) ? h('a', { class: 'btn sm ghost icon', href: link(a), target: '_blank', rel: 'noopener noreferrer', title: 'Open channel', 'aria-label': 'Open channel' }, ic('external')) : null)) : h('p', { class: 'muted tiny ad-pad' }, 'No channel connected.'))),
      card);
  });

  // ── Support requests ──
  const badge = (n) => { const b = $('#nav-tickets'); if (b) { b.textContent = n; b.hidden = !n; } };
  const statusTag = (t) => (t.status === 'resolved' ? tag('Resolved', 'ok') : tag('Open', 'warn'));
  const loadTickets = () => load('tickets', '/api/admin/tickets', (d) => {
    badge(d.tickets.filter((t) => t.status === 'open').length);
    $('#page-tickets').replaceChildren(
      d.mail ? '' : h('div', { class: 'notice warn', style: 'margin-bottom:16px' }, ic('alert'), h('div', {}, 'E-mail is not set up yet: add SUPPORT_EMAIL and SMTP_PASS in Vercel → Settings → Environment Variables. Until then requests are only listed here.')),
      h('div', { class: 'card' }, d.tickets.length ? table(['When', 'Streamer', 'Topic', 'Message', 'Screenshots', 'Status'], d.tickets.map((t) => h('tr', { class: 'ad-click', onclick: (e) => { if (!e.target.closest('a')) location.hash = `tickets/${t.id}`; } },
        whenTd(t.ts), h('td', {}, person(t)), h('td', { class: 'ad-nowrap' }, t.category),
        h('td', { class: 'msgc' }, h('a', { href: `#tickets/${t.id}` }, t.message.length > 110 ? `${t.message.slice(0, 110)}…` : t.message)),
        h('td', {}, t.shots?.length ? h('span', { class: 'ad-kind' }, ic('image'), String(t.shots.length)) : '—'),
        h('td', {}, h('div', { class: 'ad-tags' }, statusTag(t), t.mail === 'failed' ? tag('E-mail failed', 'bad') : null))))) : empty('help', 'No support requests', 'Messages from Help & support show up here.')));
  });
  const loadTicket = (id) => load('tickets', `/api/admin/tickets/${encodeURIComponent(id)}`, ({ ticket: t }) => {
    const done = t.status === 'resolved';
    const set = async () => { try { await api(`/api/admin/tickets/${t.id}`, { method: 'PUT', body: JSON.stringify({ status: done ? 'open' : 'resolved' }) }); toast(done ? 'Reopened' : 'Marked as resolved'); loadTicket(id); } catch (e) { toast(e.message, 'err'); } };
    const reply = t.email ? `mailto:${encodeURIComponent(t.email).replace('%40', '@')}?subject=${encodeURIComponent(`Re: [OmniChat #${t.id}] ${t.category}`)}` : null;
    $('#page-tickets').replaceChildren(
      h('a', { class: 'btn sm ghost ad-back', href: '#tickets' }, ic('back'), 'All requests'),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, ic('help'), h('h3', {}, t.category), statusTag(t), h('span', { class: 'sub' }, `#${t.id} · ${fullTime(t.ts)}`),
          h('div', { class: 'actions' }, reply ? h('a', { class: 'btn sm primary', href: reply }, ic('mail'), 'Reply by e-mail') : null, h('button', { class: 'btn sm', type: 'button', onclick: set }, ic(done ? 'refresh' : 'check'), done ? 'Reopen' : 'Mark resolved'))),
        h('div', { class: 'ad-ticket' }, person(t), h('p', { class: 'ad-message' }, t.message),
          t.shots?.length ? h('div', { class: 'ad-shots' }, t.shots.map((s, i) => h('a', { href: `/api/admin/shots/${encodeURIComponent(s)}`, target: '_blank', rel: 'noopener' }, h('img', { src: `/api/admin/shots/${encodeURIComponent(s)}`, alt: `Screenshot ${i + 1}`, loading: 'lazy' })))) : null),
        h('div', { class: 'ad-facts ad-facts-top' }, fact('Reply to', t.email || 'No e-mail given'), fact('E-mail to support', { sent: 'Sent', failed: 'Failed (see Issues)', off: 'Not set up' }[t.mail] || '—'),
          fact('IP', t.ip), fact('Location', place(t.loc)), fact('Device', t.device), fact('Streamer', t.name || 'Deleted user'))));
  });

  // ── Discord ──
  const DTYPE = { live: 'YouTube live', video: 'YouTube video', short: 'YouTube Short', post: 'Post', kick: 'Kick live' };
  const sentRow = (x, who = true) => h('tr', {}, whenTd(x.ts), who ? h('td', {}, person(x)) : null, h('td', { class: 'ad-nowrap' }, DTYPE[x.type] || x.type), h('td', { class: 'ad-nowrap' }, x.channel ? `#${x.channel}` : '—'),
    h('td', { class: 'msgc' }, x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.title || 'Open') : x.title || '—', x.error ? h('span', { class: 'ad-err' }, x.error) : null),
    h('td', { class: 'ad-nowrap' }, x.source || '—', x.late !== null && x.late !== undefined ? h('span', { class: 'ad-detail' }, `${x.late}s after start`) : null), h('td', {}, x.ok ? tag('Sent', 'ok') : tag('Failed', 'bad')));
  const SENT_HEAD = ['When', 'Streamer', 'Type', 'Channel', 'What', 'Noticed by', 'Result'];
  const loadDiscord = () => load('discordlog', '/api/admin/discord', (d) => {
    const s = d.setup;
    const cronOk = !!s.cronAt && Date.now() - s.cronAt < 20 * 60_000;
    const li = (ok, title, sub) => h('li', { class: ok ? 'done' : '' }, h('span', { class: 'check' }, ic(ok ? 'check' : 'alert')), h('div', { class: 'txt' }, h('b', {}, title), h('span', {}, sub)));
    const csv = () => exportCsv('omnichat-discord', ['time', 'streamer', 'type', 'channel', 'title', 'link', 'noticed by', 'seconds after start', 'result', 'error'],
      d.history.map((x) => [new Date(x.ts).toISOString(), x.name, DTYPE[x.type] || x.type, x.channel || '', x.title || '', x.url || '', x.source || '', x.late ?? '', x.ok ? 'sent' : 'failed', x.error || '']));
    $('#page-discordlog').replaceChildren(
      h('div', { class: 'grid two' },
        h('div', { class: 'card', style: 'align-self:start' }, h('div', { class: 'card-head' }, ic('users'), h('h3', {}, 'Streamers using Discord'), h('span', { class: 'sub' }, String(d.streamers.length))),
          d.streamers.length ? table(['Streamer', 'Server', 'State', 'Sent', 'Failed', 'Last post', 'Start signal', 'Video push'], d.streamers.map((u) => h('tr', { class: 'ad-click', onclick: (e) => { if (!e.target.closest('a')) location.hash = `streamers/${u.id}`; } },
            h('td', {}, person({ ...u, uid: u.id })), h('td', {}, u.server), h('td', {}, tag(u.enabled ? 'ON' : 'OFF', u.enabled ? 'ok' : '')), h('td', {}, fmtN(u.sent)), h('td', {}, u.failed ? tag(String(u.failed), 'bad') : '0'),
            h('td', { class: 'ad-nowrap' }, when(u.lastAt)), h('td', { class: 'ad-nowrap' }, when(u.obsAt)), h('td', {}, u.push ? tag('Active', 'ok') : h('span', { class: 'muted' }, '—'))))) : empty('discord', 'Nobody yet', 'Streamers who connect a Discord server show up here.')),
        h('div', { class: 'grid', style: 'align-content:start' },
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('shield'), h('h3', {}, 'Setup')), h('ul', { class: 'checklist' },
            li(s.bot, 'Discord bot', s.error || 'Connected'), li(cronOk, '1-minute backup check', cronOk ? `Last run ${ago(s.cronAt)}` : s.cron ? (s.cronAt ? `Last run ${ago(s.cronAt)}` : 'Waiting for the scheduler') : 'CRON_SECRET is missing in Vercel'),
            li(s.invite, '“Add to Discord” for streamers', s.invite ? 'Ready' : 'DISCORD_CLIENT_SECRET is missing in Vercel (not needed for the owner)'))),
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, ic('discord'), h('h3', {}, 'Servers with the bot'), h('span', { class: 'sub' }, String(d.servers.length))),
            d.servers.length ? h('ul', { class: 'ad-list' }, d.servers.map((g) => h('li', {}, h('div', { class: 'txt' }, h('b', {}, g.name), h('span', {}, g.linkedTo.length ? `Linked to ${g.linkedTo.join(', ')}` : 'Not linked to a streamer'))))) : h('p', { class: 'muted tiny ad-pad' }, 'None.')))),
      h('div', { class: 'card', style: 'margin-top:16px' }, h('div', { class: 'card-head' }, ic('send'), h('h3', {}, 'Announcements'), h('div', { class: 'actions' },
        h('a', { class: 'btn sm ghost', href: '#issues', onclick: () => { lists.issues.kind = 'discord'; } }, ic('alert'), 'Problems'), h('button', { class: 'btn sm', type: 'button', onclick: csv }, ic('download'), 'Export CSV'))),
        d.history.length ? table(SENT_HEAD, d.history.map((x) => sentRow(x))) : empty('send', 'Nothing announced yet', 'Every announcement, also a failed one, shows up here.')));
  });

  // ── Activity / Issues lists ──
  function renderList(id) {
    const st = lists[id];
    const isAct = id === 'activity';
    const kinds = isAct ? [['', 'All types'], ['failed', 'Failed only'], ...Object.entries(KINDS).filter(([k]) => k !== 'page').map(([k, v]) => [k, v[0]])] : [['', 'All types'], ...Object.entries(ISSUE_KINDS).map(([k, v]) => [k, v[0]])];
    const tbody = h('tbody');
    const note = h('div', { class: 'ad-more' });
    let rows = [];
    let next = 0;
    const row = isAct ? actionRow : issueRow;
    async function fetchRows(reset) {
      if (reset) next = 0;
      const seq = ++ui.seq;
      const n = reset ? Math.max(100, Math.min(rows.length, 500)) : 100;
      let d;
      try { d = await api(`/api/admin/${id}?limit=${n}&offset=${next}&kind=${encodeURIComponent(st.kind)}&q=${encodeURIComponent(st.q)}`); } catch (e) { if (seq === ui.seq) toast(e.message, 'err'); return; }
      if (seq !== ui.seq || getPage() !== id) return;
      rows = reset ? d.rows : [...rows, ...d.rows];
      next = d.next;
      tbody.replaceChildren(...rows.map((r) => row(r)));
      note.replaceChildren(...(!rows.length ? [empty(isAct ? 'clock' : 'check', isAct ? 'No activity found' : 'No issues found', st.q || st.kind ? 'Try another search or filter.' : 'New entries show up here from now on.')]
        : next !== null ? [h('button', { class: 'btn sm', type: 'button', onclick: () => fetchRows(false) }, 'Load older')] : [h('span', { class: 'muted tiny' }, `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} · end of list`)]));
    }
    let t;
    const search = h('div', { class: 'input-icon search' }, ic('search'), h('input', { class: 'input', type: 'search', placeholder: isAct ? 'Name, action, IP, city…' : 'Name, error, IP, ref…', value: st.q, maxlength: 100, 'aria-label': 'Search', oninput: (e) => { st.q = e.target.value; clearTimeout(t); t = setTimeout(() => fetchRows(true), 300); } }));
    const kind = h('select', { class: 'select', style: 'width:auto', 'aria-label': 'Type', onchange: (e) => { st.kind = e.target.value; fetchRows(true); } }, kinds.map(([v, l]) => h('option', { value: v, selected: v === st.kind }, l)));
    const csv = () => exportCsv(`omnichat-${id}`, ['time', 'streamer', 'user id', 'type', isAct ? 'action' : 'problem', isAct ? 'detail' : 'where', isAct ? 'result' : 'level', 'ip', 'location', 'device', 'ref'],
      rows.map((r) => [new Date(r.ts).toISOString(), r.name || '', r.uid || '', r.kind, isAct ? r.action : r.message, (isAct ? r.detail : r.where) || '', isAct ? (r.ok === false ? 'failed' : 'ok') : r.level, r.ip || '', place(r.loc) || '', r.device || '', r.id]));
    $(`#page-${id}`).replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'logbar' }, search, kind, h('div', { class: 'spacer' }), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => fetchRows(true) }, ic('refresh'), 'Refresh'), h('button', { class: 'btn sm', type: 'button', onclick: csv }, ic('download'), 'Export CSV')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, HEAD[id].map((x) => h('th', {}, x)))), tbody)), note));
    fetchRows(true);
  }

  // Keep the overview and the streamer list fresh while they are open and visible.
  ui.timer = setInterval(() => {
    if (document.hidden) return;
    if (getPage() === 'admin') loadOverview();
    if (getPage() === 'streamers' && location.hash === '#streamers') loadUsers();
    if (getPage() === 'tickets' && location.hash === '#tickets') loadTickets();
    if (getPage() === 'discordlog') loadDiscord();
  }, 30_000);

  return {
    show(id, arg) {
      if (id === 'admin') loadOverview();
      else if (id === 'streamers') {
        $('#page-streamers').replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
        if (arg) { ui.tab = 'activity'; loadUser(arg); } else loadUsers();
      } else if (id === 'discordlog') loadDiscord();
      else if (id === 'tickets') {
        $('#page-tickets').replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
        if (arg) loadTicket(arg); else loadTickets();
      } else renderList(id);
    },
  };
}

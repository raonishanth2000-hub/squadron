/* Squadron client. Every value on screen comes from the server. */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const say = (t) => { const l = $('#live'); l.textContent = ''; setTimeout(() => { l.textContent = t; }, 40); };

/* deterministic avatar colour from a user id — no stored palette needed */
function tint(id) {
  let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(140deg, hsl(${h} 62% 62%), hsl(${(h + 26) % 360} 58% 44%))`;
}
const avatar = (u, cls = 'av-s') =>
  `<span class="av ${cls}" style="background:${tint(u.id)}" title="${esc(u.name)}">${esc(initials(u.name))}</span>`;

/* ---------------------------------------------------------- api */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { status: res.status });
  return data;
}

/* ---------------------------------------------------------- state */
const S = {
  net: null,
  me: null, xp: null, ledger: [], invites: [], reads: {}, oldest: null, more: false, pins: [], mentions: [],
  squads: [], squad: null, channel: null,
  tasks: [], events: [], messages: [],
  view: 'chat', calMonth: null, calDay: null,
  ws: null, meeting: null
};

/* ---------------------------------------------------------- toast */
function toast(title, sub, kind) {
  const t = el('div', 'toast' + (kind === 'ok' ? ' ok' : ''));
  t.innerHTML = `<span class="toast-ic"><svg class="icon icon-sm" aria-hidden="true"><use href="#${kind === 'ok' ? 'i-check' : 'i-zap'}"/></svg></span>
    <div class="toast-b"><div class="toast-t"></div><div class="toast-s"></div></div>
    <button class="toast-x" aria-label="Dismiss"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"/></svg></button>`;
  $('.toast-t', t).textContent = title;
  $('.toast-s', t).textContent = sub || '';
  $('.toast-x', t).onclick = () => t.remove();
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4600);
  say(title + '. ' + (sub || ''));
}

/* ---------------------------------------------------------- modal */
function modal(title, bodyHtml, onMount) {
  const m = $('#modal'), sc = $('#modal-scrim');
  m.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2>
    <button class="icon-btn" data-close aria-label="Close"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"/></svg></button></div>
    <div class="modal-body">${bodyHtml}</div>`;
  m.hidden = sc.hidden = false;
  const close = () => { m.hidden = sc.hidden = true; };
  $('[data-close]', m).onclick = close;
  sc.onclick = close;
  onMount?.(m, close);
  return close;
}

/* ---------------------------------------------------------- auth gate */
let gateMode = 'login';
/* Signed out you get the landing page; the sign-in panel opens over it when
   you press "Open the workspace". */
function showLanding() {
  $('#app').hidden = true;
  $('#gate').hidden = true;
  $('#lp').hidden = false;                    // own it here, not via a callback
  window.Squadron?.landing?.show?.();
}
function openAuth(msg) {
  $('#gate').hidden = false;
  document.body.classList.add('gate-open');
  if (msg) { $('#gate-error').textContent = msg; $('#gate-error').hidden = false; }
  setTimeout(() => $('#f-email').focus(), 60);
}
function closeAuth() {
  $('#gate').hidden = true;
  document.body.classList.remove('gate-open');
}
window.Squadron = window.Squadron || {};
window.Squadron.openAuth = openAuth;
$$('.gate-tab').forEach(b => b.onclick = () => {
  gateMode = b.dataset.mode;
  $$('.gate-tab').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  $('#fld-name').hidden = gateMode !== 'signup';
  $('#pw-help').hidden = gateMode !== 'signup';
  $('#f-pw').autocomplete = gateMode === 'signup' ? 'new-password' : 'current-password';
  $('#gate-go').textContent = gateMode === 'signup' ? 'Create account' : 'Sign in';
  $('#gate-error').hidden = true;
});
$('#pw-toggle').onclick = () => {
  const i = $('#f-pw'), on = i.type === 'password';
  i.type = on ? 'text' : 'password';
  $('#pw-toggle').textContent = on ? 'Hide' : 'Show';
  $('#pw-toggle').setAttribute('aria-pressed', String(on));
};
$('#gate-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#gate-go');
  btn.disabled = true;
  $('#gate-error').hidden = true;
  try {
    const payload = {
      email: $('#f-email').value.trim(),
      password: $('#f-pw').value,
      ...(gateMode === 'signup' ? { name: $('#f-name').value.trim() } : {})
    };
    const { user } = await api('POST', gateMode === 'signup' ? '/api/auth/signup' : '/api/auth/login', payload);
    $('#f-pw').value = '';
    closeAuth();
    /* the curtain types you across while the workspace loads behind it */
    const land = window.Squadron?.landing;
    if (land?.curtain) {
      await new Promise(res => land.curtain(user.name, res));
      await boot();
    } else {
      land?.hide();
      await boot();
    }
    await handleDeepLink();
  } catch (err) {
    $('#gate-error').textContent = err.message;
    $('#gate-error').hidden = false;
    $('#f-pw').focus();
  } finally { btn.disabled = false; }
};
/* signing out lives in settings now — the bare arrow that used to sit beside
   the name read as "next", not "leave" */
async function signOut() {
  try { await api('POST', '/api/auth/logout'); } catch {}
  location.reload();
}
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#gate').hidden) closeAuth(); });
$('#gate').addEventListener('click', (e) => { if (e.target === $('#gate')) closeAuth(); });

/* ---------------------------------------------------------- boot */
async function boot() {
  let me;
  try { me = await api('GET', '/api/me'); }
  catch { showLanding(); return; }

  S.me = me.user; S.xp = me.xp; S.ledger = me.ledger; S.invites = me.pendingInvites;
  closeAuth();
  $('#lp').hidden = true;
  window.Squadron?.landing?.hide?.();
  $('#app').hidden = false;

  paintMe();

  if (S.invites.length) setTimeout(showInvitesDialog, 700);

  S.net = await api('GET', '/api/net').catch(() => null);
  await loadSquads();
  openSocket();
  renderXp();
  loadStandings();
  loadMentions();
  loadDmList();
  startSoonWatch();

  /* offer the walk-through once the workspace it describes is actually on
     screen — pointing at a half-built sidebar teaches nothing */
  /* Offered once the workspace it describes is on screen. A brand new account
     has no squad yet, so this also fires the first time one appears — without
     it the tour reached nobody it was built for. */
  maybeOfferTour();
}

async function loadSquads() {
  const { squads } = await api('GET', '/api/squads');
  S.squads = squads;
  renderSquadList();
  if (squads.length) await openSquad(S.squad?.id && squads.find(s => s.id === S.squad.id) ? S.squad.id : squads[0].id);
  else emptyWorkspace();
}

function emptyWorkspace() {
  S.squad = null;
  /* nothing to send to: the box did nothing at all when used */
  document.body.dataset.nosquad = '1';
  $('#sw-n').textContent = 'No squad yet';
  $('#sw-s').textContent = 'create or join one';
  $('#sw-av').textContent = '--';
  $('#side-scroll').innerHTML = '';
  $('#msgs').innerHTML = `<div class="hollow">
      <h3>You are not in a squad yet</h3>
      <p>A squad is where your channels, board, calendar and meetings live. Start one and invite the people you are competing with.</p>
      <button class="btn btn-primary" id="hollow-new"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-plus"/></svg>Create your first squad</button>
    </div>`;
  $('#hollow-new').onclick = squadWizard;
  $('#ctx-body').innerHTML = '';
  $('#board').innerHTML = '';
  $('#top-title').querySelector('span').textContent = 'Squadron';
  $('#top-note').textContent = '';
}


/* `localhost` resolves to whoever opens the link, so shared URLs use the LAN
   address this server is actually reachable on. */
function shareBase() {
  const here = location.origin;
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(here);
  if (!isLocal) return here;                 // already opened over the network
  return S.net?.public || S.net?.lan?.[0] || here;
}
/* Classify by the address itself, not by how the server was configured —
   a tunnel hostname is reachable whether or not anyone set PUBLIC_URL. */
function reachKind(url = shareBase()) {
  let host;
  try { host = new URL(url).hostname; } catch { return 'local'; }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local';
  const priv = /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host)
    || host.endsWith('.local');
  return priv ? 'lan' : 'public';
}

/* ---------------------------------------------------------- squads */
function renderSquadList() {
  const list = $('#squad-list');
  list.innerHTML = S.squads.map(s => `
    <button class="sq-item" role="menuitemradio" aria-checked="${s.id === S.squad?.id}" data-squad="${s.id}">
      <span class="sq-av">${esc(initials(s.name))}</span>
      <span class="sq-t"><b>${esc(s.name)}</b><span>${esc(s.kindLabel)} · ${s.members.length} member${s.members.length === 1 ? '' : 's'}</span></span>
      <svg class="icon icon-sm sq-tick" aria-hidden="true"><use href="#i-check"/></svg>
    </button>`).join('') || '<p class="sw-empty">No squads yet.</p>';

  S.invites.forEach(inv => {
    const b = el('button', 'sq-item sq-invite', `
      <span class="sq-av">${esc(initials(inv.squad_name))}</span>
      <span class="sq-t"><b>${esc(inv.squad_name)}</b><span>invitation · tap to accept</span></span>
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-plus"/></svg>`);
    b.onclick = async () => {
      try {
        const { squad } = await api('POST', `/api/invites/${inv.id}/accept`);
        S.invites = S.invites.filter(i => i.id !== inv.id);
        toast(`Joined ${squad.name}`, 'Its channels and board are yours now.', 'ok');
        await loadSquads();
        await openSquad(squad.id);
      } catch (e) { toast('Could not join', e.message); }
    };
    list.appendChild(b);
  });

  $$('.sq-item[data-squad]', list).forEach(b => b.onclick = () => { closeSw(); openSquad(b.dataset.squad); });
}

async function openSquad(id) {
  const bundle = await api('GET', `/api/squads/${id}`);
  delete document.body.dataset.nosquad;
  S.squad = bundle.squad;
  S.tasks = bundle.tasks;
  S.events = bundle.events;
  S.channel = S.squad.channels[0] || null;

  $('#sw-n').textContent = S.squad.name;
  $('#sw-s').textContent = `${S.squad.kindLabel} · ${S.squad.members.length} member${S.squad.members.length === 1 ? '' : 's'}`;
  $('#sw-av').textContent = initials(S.squad.name);
  $('#m-sub').textContent = S.squad.kindLabel;

  renderSquadList();
  renderChannels();
  renderRoster();
  renderBoard();
  renderCalendar();
  if (S.channel) { markChannelRead(S.channel); renderChannels(); await loadMessages(S.channel.id); }
  maybeOfferTour();
  S.ws?.readyState === 1 && S.ws.send(JSON.stringify({ type: 'watch', squadId: id }));
  setView(S.view);
}

/* A channel's symbol is whatever the creator picked — emoji, sign, or letter.
   It is text, not an icon sprite, so anything the user can type works. */
const channelSym = (c) => (c && (S.squad?.channels.find(x => x.id === c.id)?.icon || c.icon)) || '#';

function chanGlyph(c) {
  return `<span class="chan-sym" aria-hidden="true">${esc(c.icon || '#')}</span>`;
}

function renderChannels() {
  const s = S.squad;
  const dmUnread = (S.dmThreads || []).reduce((n, t) => n + (t.unread || 0), 0);
  $('#side-scroll').innerHTML = `
    <div class="grp"><div class="grp-h"><svg class="icon" style="width:11px;height:11px" aria-hidden="true"><use href="#i-chev-d"/></svg>Text
      <button class="grp-add" data-add-chan aria-label="Add a channel" title="Add a channel">
        <svg class="icon" style="width:11px;height:11px" aria-hidden="true"><use href="#i-plus"/></svg></button></div>
      ${s.channels.map(c => `<span class="chan-slot">
        <button class="chan" data-chan="${c.id}" ${c.id === S.channel?.id && S.view !== 'dm' ? 'aria-current="true"' : ''}>
          ${chanGlyph(c)}<span class="chan-name">${esc(c.name)}</span>
          ${c.unread > 0 && (c.id !== S.channel?.id || S.view === 'dm') ? `<span class="chan-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
        </button>
        ${s.role === 'captain' && s.channels.length > 1
          ? `<button class="chan-x" data-del-chan="${c.id}" data-name="${esc(c.name)}"
               aria-label="Delete ${esc(c.name)}" title="Delete this channel">×</button>` : ''}
      </span>`).join('')}
    </div>

    <div class="grp"><div class="grp-h"><svg class="icon" style="width:11px;height:11px" aria-hidden="true"><use href="#i-chev-d"/></svg>Direct
      <button class="grp-add" data-new-dm aria-label="Start a conversation" title="Message someone">
        <svg class="icon" style="width:11px;height:11px" aria-hidden="true"><use href="#i-plus"/></svg></button></div>
      ${(S.dmThreads || []).length
        ? (S.dmThreads || []).map(t => `<button class="chan" data-dm="${t.id}" ${t.id === DM.thread?.id && S.view === 'dm' ? 'aria-current="true"' : ''}>
            <span class="av av-xs" style="background:${tint(t.other_id)}">${esc(initials(t.other_name))}</span>
            <span class="chan-name">${esc(t.other_name)}</span>
            ${t.unread > 0 && !(t.id === DM.thread?.id && S.view === 'dm') ? `<span class="chan-badge">${t.unread > 99 ? '99+' : t.unread}</span>` : ''}
          </button>`).join('')
        : '<p class="grp-empty">Nobody yet — press + to message a teammate.</p>'}
    </div>

    <div class="grp"><div class="grp-h"><svg class="icon" style="width:11px;height:11px" aria-hidden="true"><use href="#i-chev-d"/></svg>Work</div>
      <button class="chan" data-view="board"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-board"/></svg><span class="chan-name">Task board</span></button>
      <button class="chan" data-view="cal"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-cal"/></svg><span class="chan-name">Calendar</span></button>
      <button class="chan" data-view="xp"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-trophy"/></svg><span class="chan-name">Standings &amp; XP</span></button>
    </div>

    <div class="grp"><div class="grp-h"><svg class="icon" style="width:11px;height:11px" aria-hidden="true"><use href="#i-chev-d"/></svg>Studio</div>
      <button class="chan" data-code-open><svg class="icon icon-sm" aria-hidden="true"><use href="#i-code"/></svg><span class="chan-name">Compiler</span></button>
      <button class="chan" data-view="draw"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-move"/></svg><span class="chan-name">Whiteboard</span></button>
    </div>`;
  markSideOverflow();
}

/* the sidebar gained two groups and a timer; show a hint when it is cut off */
function markSideOverflow() {
  const sc = $('#side-scroll'), wrap = $('#side-wrap');
  if (!sc || !wrap) return;
  const more = sc.scrollHeight - sc.clientHeight - sc.scrollTop > 6;
  wrap.dataset.more = more ? '1' : '0';
}
$('#side-scroll')?.addEventListener('scroll', markSideOverflow);
addEventListener('resize', markSideOverflow);

$('#side-scroll').addEventListener('click', (e) => {
  const b = e.target.closest('.chan');
  if (!b) return;
  if (b.dataset.dm) { openDm(b.dataset.dm); closeDrawer(); return; }
  if (b.dataset.chan) {
    S.channel = S.squad.channels.find(c => c.id === b.dataset.chan);
    markChannelRead(S.channel);
    renderChannels();
    loadMessages(S.channel.id);
    setView('chat');
  } else if (b.hasAttribute('data-code-open')) { openCode(); }
  else setView(b.dataset.view);
  closeDrawer();
});

/* Opening a channel clears its badge here and on the server, so the count
   does not come back on the next squad fetch. */
function markChannelRead(c) {
  if (!c) return;
  c.unread = 0;
  api('POST', `/api/channels/${c.id}/read`)
    .then(r => { if (r?.readAt && S.me) S.reads[S.me.id] = r.readAt; })
    .catch(() => {});
}

$('#side-scroll').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del-chan]');
  if (del) { e.stopPropagation(); return deleteChannelDialog(del.dataset.delChan, del.dataset.name); }
  if (e.target.closest('[data-add-chan]')) { e.stopPropagation(); openChannelWizard(); }
  if (e.target.closest('[data-new-dm]')) { e.stopPropagation(); newDmDialog(); }
}, true);

function renderRoster() {
  const s = S.squad;
  const seats = s.cap - s.members.length;
  $('#ctx-body').innerHTML = `
    <div class="ctx-sec"><span class="eyebrow">Roster — ${s.members.length} of ${s.cap}</span>
      ${s.members.map(m => `<div class="member">${avatar(m, 'av-m')}
        <span class="member-b"><span class="member-n">${esc(m.name)}</span>
        <span class="member-s">${esc(m.handle)}${m.role === 'captain' ? ' · captain' : m.role === 'advisor' ? ' · advisor' : ''}</span></span></div>`).join('')}
      <button class="btn btn-sm" id="invite-btn" style="margin-top:8px;width:100%;justify-content:center">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-plus"/></svg>${seats > 0 ? `Invite (${seats} seat${seats === 1 ? '' : 's'} open)` : 'Invite (squad is full)'}</button>
      ${s.role === 'captain' ? `<button class="btn btn-sm" id="settings-btn" style="margin-top:6px;width:100%;justify-content:center">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-sliders"/></svg>Squad settings</button>` : ''}
    </div>
    <div class="ctx-sec"><span class="eyebrow">This squad</span><div class="ctx-card">
      <div class="ctd"><span class="k">Competition</span><span class="v mono">${esc(s.kindLabel)}</span></div>
      <div class="ctd"><span class="k">Tasks</span><span class="v mono">${S.tasks.filter(t => t.col === 'Solved').length} of ${S.tasks.length} solved</span></div>
      <div class="ctd"><span class="k">Upcoming</span><span class="v mono">${S.events.filter(e => e.starts_at > Date.now()).length} scheduled</span></div>
    </div></div>`;
  $('#invite-btn')?.addEventListener('click', inviteDialog);
  $('#settings-btn')?.addEventListener('click', squadSettings);
}

function inviteDialog() {
  modal('Add people to ' + S.squad.name, `
    <div class="fld"><label for="inv-search">Search for them by name</label>
      <input id="inv-search" type="search" autocomplete="off" spellcheck="false"
        placeholder="Type a name or handle" aria-controls="inv-people">
      <p class="fld-help" id="inv-seats"></p></div>
    <div class="inv-people" id="inv-people" role="listbox" aria-label="People"></div>

    <div class="inv-split"><span>or send a link</span></div>

    <p class="note-warn" id="inv-reach"></p>
    <div class="fld"><label for="inv-link">Invite link</label>
      <div class="fld-pw"><input id="inv-link" type="text" readonly value="creating…">
        <button type="button" class="pw-toggle" id="inv-copy">Copy</button></div>
      <p class="fld-help">For anyone without an account yet. Squadron does not send email —
        pass it on however you normally talk.</p></div>

    <details class="inv-more"><summary>Or reserve a seat by email</summary>
      <p class="modal-sub" style="margin-top:10px">For someone who has not signed up yet — the invitation appears
        the first time they sign in with that address.</p>
      <div class="fld"><label for="inv-email">Their account email</label>
        <input id="inv-email" type="email" autocomplete="off" spellcheck="false"></div>
      <div class="fld"><label for="inv-role">Role</label>
        <select id="inv-role"><option value="member">Member</option><option value="advisor">Faculty advisor</option></select></div>
      <button class="btn btn-primary" id="inv-go" style="width:100%;justify-content:center">Reserve their seat</button>
    </details>
    <p class="gate-error" id="inv-err" hidden></p>`,
  async (m, close) => {
    /* search the people who already have accounts, rather than asking for an
       email address you probably do not know */
    const box = $('#inv-people', m), input = $('#inv-search', m);
    let timer;
    const drawPeople = (people, term) => {
      if (!term || term.length < 2) { box.innerHTML = ''; return; }
      box.innerHTML = people.length
        ? people.map(p => `<div class="inv-p" data-p="${p.id}">
            <span class="av av-s" style="background:${tint(p.id)}">${esc(initials(p.name))}</span>
            <span class="inv-p-b"><span class="inv-p-n">${esc(p.name)}</span>
              <span class="inv-p-h mono">${esc(p.handle)}</span></span>
            ${p.member ? '<span class="inv-p-s">in this squad</span>'
              : p.invited ? '<span class="inv-p-s">invited</span>'
              : `<button class="btn btn-sm" data-invite="${p.id}" data-name="${esc(p.name)}">Invite</button>`}
          </div>`).join('')
        : `<p class="fld-help">Nobody signed in matches “${esc(term)}”. Send them the link below instead.</p>`;
    };
    input.oninput = () => {
      clearTimeout(timer);
      const term = input.value.trim();
      if (term.length < 2) { box.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        try {
          const d = await api('GET', `/api/people?q=${encodeURIComponent(term)}&squad=${S.squad.id}`);
          drawPeople(d.people, d.term);
        } catch (e) { box.innerHTML = `<p class="gate-error">${esc(e.message)}</p>`; }
      }, 220);
    };
    box.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-invite]');
      if (!b) return;
      b.disabled = true; b.textContent = 'Inviting…';
      try {
        await api('POST', `/api/squads/${S.squad.id}/invites/user`, { userId: b.dataset.invite });
        b.replaceWith(Object.assign(document.createElement('span'), { className: 'inv-p-s', textContent: 'invited' }));
        toast('Invitation sent', `${b.dataset.name} will see it next time they open Squadron.`, 'ok');
      } catch (e) {
        toast('Could not invite them', e.message);
        b.disabled = false; b.textContent = 'Invite';
      }
    });
    setTimeout(() => input.focus(), 80);

    const reach = $('#inv-reach', m);
    const kind = reachKind();
    if (kind === 'public') {
      reach.className = 'note-ok';
      reach.innerHTML = '<b>Works from anywhere.</b> This goes through your tunnel, so your friend does not need to be ' +
        'on your wifi — and camera and screen share work for them too.';
    } else if (kind === 'lan') {
      reach.innerHTML = '<b>Same wifi only.</b> This address points at your laptop, so your squad has to be on the ' +
        'same network. Someone elsewhere will see “site can’t be reached”.';
    } else {
      reach.innerHTML = '<b>This link only works on this computer.</b> Squadron is running on your laptop, ' +
        'so nobody else can reach it yet.';
    }
    const seats = S.squad.cap - S.squad.members.length;
    $('#inv-seats', m).textContent = seats > 0
      ? `${seats} seat${seats === 1 ? '' : 's'} open of ${S.squad.cap}. Change the limit in squad settings.`
      : `This squad is full at ${S.squad.cap}. Raise the limit in squad settings before anyone can join.`;
    try {
      const { invite } = await api('POST', `/api/squads/${S.squad.id}/invites`, {});
      $('#inv-link', m).value = shareBase() + invite.link;
    } catch (e) { $('#inv-link', m).value = ''; $('#inv-err', m).textContent = e.message; $('#inv-err', m).hidden = false; }

    $('#inv-copy', m).onclick = async () => {
      const v = $('#inv-link', m).value;
      try { await navigator.clipboard.writeText(v); $('#inv-copy', m).textContent = 'Copied'; setTimeout(() => { $('#inv-copy', m).textContent = 'Copy'; }, 1600); }
      catch { $('#inv-link', m).select(); }
    };
    $('#inv-go', m).onclick = async () => {
      try {
        await api('POST', `/api/squads/${S.squad.id}/invites`, { email: $('#inv-email', m).value, role: $('#inv-role', m).value });
        close();
        toast('Seat reserved', 'They will see it the next time they sign in.', 'ok');
        await openSquad(S.squad.id);
      } catch (e) { $('#inv-err', m).textContent = e.message; $('#inv-err', m).hidden = false; }
    };
  });
}

/* ---- squad settings: the size is a choice, and it can change ---- */
function squadSettings() {
  const s = S.squad;
  modal('Squad settings', `
    <div class="fld"><label for="s-name">Name</label><input id="s-name" type="text" value="${esc(s.name)}"></div>
    <div class="fld"><label for="s-tag">One line about it</label><input id="s-tag" type="text" value="${esc(s.tagline || '')}"></div>
    <div class="fld"><label for="s-cap">How many people can join</label>
      <input id="s-cap" type="number" min="${s.members.length}" max="200" value="${s.cap}">
      <p class="fld-help">${s.members.length} here now. ${esc(s.kindLabel)}s usually run at ${KINDS[s.kind]?.cap ?? s.cap}, but that is only a suggestion.</p></div>
    <p class="gate-error" id="s-err" hidden></p>
    <button class="btn btn-primary btn-lg" id="s-go" style="width:100%;justify-content:center">Save</button>`,
  (m, close) => {
    $('#s-go', m).onclick = async () => {
      try {
        const { squad } = await api('PATCH', `/api/squads/${s.id}`, {
          name: $('#s-name', m).value, tagline: $('#s-tag', m).value, cap: Number($('#s-cap', m).value)
        });
        close();
        await loadSquads();
        await openSquad(squad.id);
        toast('Squad updated', `${squad.name} · up to ${squad.cap} people`, 'ok');
      } catch (e) { $('#s-err', m).textContent = e.message; $('#s-err', m).hidden = false; }
    };
  });
}

/* ---------------------------------------------------------- chat */
async function loadMessages(channelId) {
  const { channel, messages, reads, more, oldest } = await api('GET', `/api/channels/${channelId}/messages?limit=60`);
  S.messages = messages;
  S.oldest = oldest; S.more = !!more;
  $('#older').hidden = !more;
  S.reads = Object.fromEntries((reads || []).map(r => [r.user_id, r.read_at]));
  TYPERS.clear(); paintTyping();
  loadPins();
  const sym = channelSym(channel);
  $('#composer').placeholder = 'Message ' + sym + ' ' + channel.name;
  $('#top-title').innerHTML =
    `<span class="top-sym" id="top-sym" aria-hidden="true">${esc(sym)}</span><span>${esc(channel.name)}</span>`;
  $('#m-title').textContent = sym + ' ' + channel.name;
  renderMessages();
}

/* Shared snippets arrive as ``` fenced blocks. Split them out so the code keeps
   its whitespace and gets its own copy button, and escape every part. */
function bodyHtml(raw) {
  const parts = String(raw).split(/```/);
  return parts.map((part, i) => {
    if (i % 2 === 0) {
      const t = part.replace(/^\n+|\n+$/g, '');
      return t ? `<p>${esc(t).replace(/\n/g, '<br>')}</p>` : '';
    }
    const nl = part.indexOf('\n');
    const lang = nl > -1 ? part.slice(0, nl).trim() : '';
    const code = (nl > -1 ? part.slice(nl + 1) : part).replace(/\n+$/, '');
    return `<div class="msg-code-h"><span class="msg-code-l">${esc(lang || 'code')}</span>
      <button class="msg-code-c" data-copy-code>Copy</button></div>
      <pre class="msg-code">${esc(code)}</pre>`;
  }).join('');
}

/* The picker is part of the message rather than a floating layer: it sits
   directly under the bubble and the full set expands in the same place. It is
   positioned absolutely inside the wrapper so revealing it never reflows the
   conversation above or below. */
function pickerBar(m) {
  const mine = m.reacted || [];
  const opt = (k) => `<button class="rx-opt" data-k="${k}" tabindex="-1"
    title="${esc(RX_LABEL[k] || k)}" aria-label="React ${esc(RX_LABEL[k] || k)}"
    ${mine.includes(k) ? 'data-mine="1"' : ''}>${esc(RX_EMOJI[k])}</button>`;
  /* The smile sits in the message's own flow so it genuinely reads as "below
     this message". The emoji it opens are absolutely positioned, so the
     conversation never reflows when they appear or when the tray expands. */
  return `<div class="rx-add">
    <button class="rx-smile" data-smile aria-expanded="false" aria-label="Add a reaction">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9"/>
        <path d="M8.4 14.3a4.6 4.6 0 0 0 7.2 0"/>
        <circle cx="9.2" cy="9.8" r="1" fill="currentColor" stroke="none"/>
        <circle cx="14.8" cy="9.8" r="1" fill="currentColor" stroke="none"/></svg>
    </button>
    <div class="rx-bar" data-open="0">
      <div class="rx-row">${RX_QUICK.map(opt).join('')}
        <button class="rx-more" data-more tabindex="-1" aria-expanded="false" aria-label="More reactions">
          <svg class="icon icon-sm" aria-hidden="true"><use href="#i-chev-d"/></svg></button></div>
      <div class="rx-tray">${RX.filter(k => !RX_QUICK.includes(k)).map(opt).join('')}</div>
    </div>
  </div>`;
}

/* ---- read receipts ----
   Derived from each member's last-read mark for the channel rather than a row
   per message: if someone's mark is at or past a message's timestamp, they
   have seen it. Shown only under your own messages — you already know you
   read the rest. */
function seenBy(m) {
  const reads = S.reads || {};
  return (S.squad?.members || []).filter(p =>
    p.id !== m.author.id && (reads[p.id] || 0) >= m.created_at);
}

function seenLine(m) {
  const who = seenBy(m);
  if (!who.length) return '';
  const others = (S.squad?.members || []).filter(p => p.id !== m.author.id).length;
  const all = others > 0 && who.length === others;
  const names = who.map(p => p.name.split(' ')[0]);
  const label = all && who.length > 1 ? 'Seen by everyone'
    : who.length <= 2 ? 'Seen by ' + names.join(' and ')
    : `Seen by ${names[0]}, ${names[1]} +${who.length - 2}`;
  return `<div class="seen" title="${esc(who.map(p => p.name).join(', '))}">
    <span class="seen-avs">${who.slice(0, 3).map(p =>
      `<span class="seen-av" style="background:${tint(p.id)}">${esc(initials(p.name))}</span>`).join('')}</span>
    <span class="seen-t">${esc(label)}</span></div>`;
}

/* A conversation without day boundaries reads as one endless block; you cannot
   tell a reply from this morning from one three weeks ago. */
const dayStamp = (ms) => new Date(ms).toDateString();
function dayLabel(ms) {
  const d = new Date(ms), now2 = new Date();
  const days = Math.round((new Date(now2.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', ...(d.getFullYear() !== now2.getFullYear() ? { year: 'numeric' } : {}) });
}
const daySep = (ms) => `<div class="day-sep" role="separator"><span>${esc(dayLabel(ms))}</span></div>`;

function renderMessages() {
  const box = $('#msgs');
  if (!S.messages.length) {
    box.innerHTML = `<div class="hollow">
      <span class="hollow-mark" aria-hidden="true">${esc(channelSym(S.channel))}</span>
      <h3>This is the start of #${esc(S.channel?.name || '')}</h3>
      <p>Say something and it will be here when the rest of the squad signs in.
         Drop in code, a voice note, or a page from the whiteboard.</p>
      <button class="btn btn-primary btn-sm" data-focus-composer>Write the first message</button></div>`;
    $('[data-focus-composer]', box)?.addEventListener('click', () => $('#composer').focus());
    return;
  }
  /* Only the newest message they have reached carries the receipt. Repeating
     it under every message stacked four "Seen by" lines down one screen and
     said nothing the last one did not. */
  const lastSeenId = [...S.messages].reverse()
    .find(x => x.author.id === S.me?.id && seenBy(x).length)?.id || null;
  let last = null;
  box.innerHTML = S.messages.map(m => {
    const newDay = !last || dayStamp(last.created_at) !== dayStamp(m.created_at);
    const sep = newDay ? daySep(m.created_at) : '';
    const mine = m.author.id === S.me?.id;
    /* Two messages from the same person only stack while they are within 30s of
   each other; past that the name and time come back, so a later reply never
   reads as part of an earlier thought. */
    const cont = !newDay && last && last.author.id === m.author.id && (m.created_at - last.created_at) < 3e4;
    last = m;
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    /* Reactions hang off the bottom edge of the bubble rather than sitting
       inside it, the way they do in WhatsApp — the message keeps its shape. */
    const rx = m.reactions.map(r => `<button class="react" data-rx="${r.key}" data-msg="${m.id}"
        ${m.reacted.includes(r.key) ? 'data-mine="1" aria-pressed="true"' : 'aria-pressed="false"'}
        title="${esc(RX_LABEL[r.key] || r.key)}"><span class="react-e">${esc(RX_EMOJI[r.key] || '·')}</span>${r.n > 1 ? `<span class="react-n">${r.n}</span>` : ''}</button>`).join('');
    const seen = (mine && m.id === lastSeenId) ? seenLine(m) : '';
    /* Your own messages sit on the right; everyone else stays left. The
       avatar column is dropped on your side — you know who you are. */
    return sep + `<article class="msg${cont ? ' cont' : ''}${mine ? ' mine' : ''}${rx ? ' has-rx' : ''}${m.deleted ? ' gone-msg' : ''}${m.pinnedAt ? ' pinned' : ''}" data-msg="${m.id}">
      ${mine ? '' : cont ? `<span class="av av-m" aria-hidden="true" style="background:${tint(m.author.id)};opacity:0"></span>` : avatar(m.author, 'av-m')}
      <div><div class="msg-head"><span class="msg-name">${mine ? 'You' : esc(m.author.name)}</span>
        ${mine ? '' : `<span class="msg-handle mono">${esc(m.author.handle)}</span>`}<span class="msg-time mono">${time}</span></div>
        <div class="msg-wrap">
          <div class="msg-body">${m.deleted ? '<p class="gone">This message was deleted</p>'
            : m.kind === 'voice' ? voiceHtml(m)
            : (m.body ? bodyHtml(m.body) : '') +
              (m.image ? `<img class="msg-img" src="/api/images/${m.image}" alt="Shared picture" loading="lazy" data-zoom>` : '') + fileHtml(m.file)}${
            m.editedAt && !m.deleted ? '<span class="edited mono">edited</span>' : ''}</div>
          ${rx ? `<div class="reacts">${rx}</div>` : ''}
          ${m.replies ? `<button class="thread-link" data-open-thread>${m.replies} ${m.replies === 1 ? 'reply' : 'replies'}</button>` : ''}
          ${m.deleted ? '' : pickerBar(m)}
        </div>${seen}</div>${msgMenu(m)}</article>`;
  }).join('');
  if (nowPlaying && !document.contains(nowPlaying.box)) { nowPlaying.audio.pause(); nowPlaying = null; }
  $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
}

$('#send').onclick = sendMessage;
$('#composer').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('#composer').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
  announceTyping();
});
async function sendMessage() {
  const box = $('#composer'), body = box.value.trim();
  if (!S.channel) return;
  /* a staged file goes with whatever was typed as its caption, and an
     attachment on its own is a message — an empty box is not a reason to stop */
  if (ATT.chat) {
    box.value = ''; box.style.height = 'auto';
    try { await sendStaged('chat', body); } catch { box.value = body; }
    return;
  }
  if (!body) return;
  box.value = ''; box.style.height = 'auto';
  try {
    const { message } = await api('POST', `/api/channels/${S.channel.id}/messages`, { body });
    upsertMessage(message);
  } catch (e) { toast('Message not sent', e.message); box.value = body; }
}

/* ---------------------------------------------------------- meeting reminders */
/* A meeting you forget about is the same as a meeting that never happened, so
   the workspace says something ten minutes ahead. There is no service worker
   here, which means nothing can reach you once the tab is closed — what this
   does cover is the tab left open in the background, which is where a squad
   actually leaves Squadron sitting. */
const LEAD_MS = 10 * 60 * 1000;
const SOON = {
  alerted: new Set(),      // events already announced, so a poll cannot repeat one
  showing: null,
  timer: null
};

/* Survives a reload — otherwise refreshing the page re-announces the same
   meeting, which is how a helpful reminder turns into a nuisance. */
try {
  const keep = JSON.parse(localStorage.getItem('sq.alerted') || '[]');
  const fresh = keep.filter(x => x.t > Date.now() - 6 * 3600e3);
  fresh.forEach(x => SOON.alerted.add(x.id));
  localStorage.setItem('sq.alerted', JSON.stringify(fresh));
} catch {}

function rememberAlerted(id) {
  SOON.alerted.add(id);
  try {
    const keep = JSON.parse(localStorage.getItem('sq.alerted') || '[]');
    keep.push({ id, t: Date.now() });
    localStorage.setItem('sq.alerted', JSON.stringify(keep.slice(-40)));
  } catch {}
}

const minutesTo = (ms) => Math.max(0, Math.round(ms / 60000));

function soonWord(ms) {
  const m = minutesTo(ms);
  return m <= 0 ? 'starting now' : m === 1 ? 'in a minute' : `in ${m} minutes`;
}

function hideSoon() {
  SOON.showing = null;
  $('#soon').hidden = true;
  $('#soon').innerHTML = '';
}

function drawSoon(ev) {
  const bar = $('#soon');
  SOON.showing = ev;
  bar.hidden = false;
  const canAsk = 'Notification' in window && Notification.permission === 'default';
  bar.innerHTML = `<span class="soon-dot" aria-hidden="true"></span>
    <span class="soon-b"><b class="soon-t"></b>
      <span class="soon-s mono"></span></span>
    ${ev.meeting_id ? '<button class="btn btn-sm btn-primary" data-soon-join>Join now</button>' : ''}
    ${canAsk ? '<button class="btn btn-sm" data-soon-alerts>Desktop alerts</button>' : ''}
    <button class="icon-btn" data-soon-x aria-label="Dismiss this reminder">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"/></svg></button>`;
  $('.soon-t', bar).textContent = ev.title;
  $('.soon-s', bar).textContent = `${ev.squad_name} · ${soonWord(ev.starts_at - Date.now())}`;
  $('[data-soon-x]', bar).onclick = hideSoon;
  $('[data-soon-join]', bar)?.addEventListener('click', () => { hideSoon(); joinMeeting(ev.meeting_id); });
  $('[data-soon-alerts]', bar)?.addEventListener('click', async () => {
    /* asked from a real click, which is the only way a browser will consider it */
    try {
      const r = await Notification.requestPermission();
      toast(r === 'granted' ? 'Desktop alerts on' : 'Desktop alerts not enabled',
        r === 'granted' ? 'You will get a notification ten minutes before a meeting.'
          : 'You will still see the banner here.', r === 'granted' ? 'ok' : undefined);
      if (SOON.showing) drawSoon(SOON.showing);
    } catch {}
  });
}

function notifyDesktop(ev) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(ev.title, {
      body: `${ev.squad_name} · ${soonWord(ev.starts_at - Date.now())}`,
      tag: 'sq-' + ev.id                       // replaces rather than stacks
    });
    n.onclick = () => { window.focus(); if (ev.meeting_id) joinMeeting(ev.meeting_id); n.close(); };
  } catch {}
}

async function pollSoon() {
  if (!S.me) return;
  let events = [];
  try { ({ events } = await api('GET', '/api/upcoming?within=30')); }
  catch { return; }                            // offline or signed out; try again next tick

  const now = Date.now();
  /* the soonest thing inside the window that has not been announced yet */
  const due = events
    .filter(e => e.starts_at - now <= LEAD_MS && e.starts_at - now > -60000)
    .sort((a, b) => a.starts_at - b.starts_at);

  for (const ev of due) {
    if (SOON.alerted.has(ev.id)) continue;
    rememberAlerted(ev.id);
    drawSoon(ev);
    notifyDesktop(ev);
    toast(ev.title + ' ' + soonWord(ev.starts_at - now), ev.squad_name, 'ok');
    break;                                     // one at a time, never a stack
  }

  /* keep the countdown on a banner already up honest */
  if (SOON.showing) {
    const live = events.find(e => e.id === SOON.showing.id);
    if (!live || live.starts_at - now < -5 * 60000) hideSoon();
    else $('.soon-s', $('#soon')).textContent = `${live.squad_name} · ${soonWord(live.starts_at - now)}`;
  }
}

function startSoonWatch() {
  clearInterval(SOON.timer);
  pollSoon();
  SOON.timer = setInterval(pollSoon, 30000);
}

/* ---------------------------------------------------------- attachments */
/* One picked file waiting in a composer. Held per surface so a file staged in
   a DM does not follow you into a channel. */
const ATT = { chat: null, dm: null };
const FILE_MAX = 25 * 1024 * 1024;

const niceSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'
  : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';

/* what the bubble should do with it, decided from the type the browser gave us */
const fileKind = (mime = '') =>
  /^image\//.test(mime) && mime !== 'image/svg+xml' ? 'image'
  : /^video\//.test(mime) ? 'video'
  : /^audio\//.test(mime) ? 'audio' : 'doc';

/* Raw bytes on the wire with the details in the query string. Sent with
   XMLHttpRequest rather than fetch because it is the only one that reports
   upload progress, and a 20MB video over a phone tether needs a bar. */
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ name: file.name || 'attachment', mime: file.type || 'application/octet-stream' });
    const x = new XMLHttpRequest();
    x.open('POST', '/api/files?' + qs);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => {
      let d = {}; try { d = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300 && d.file) resolve(d.file);
      else reject(new Error(d.error || 'That upload failed.'));
    };
    x.onerror = () => reject(new Error('The connection dropped mid-upload.'));
    x.onabort = () => reject(new Error('Upload cancelled.'));
    x.send(file);
  });
}

function trayEl(which) { return $(which === 'dm' ? '#dm-tray' : '#attach-tray'); }

function drawTray(which) {
  const tray = trayEl(which), a = ATT[which];
  if (!a) { tray.hidden = true; tray.innerHTML = ''; return; }
  tray.hidden = false;
  const thumb = a.preview
    ? `<img class="att-thumb" src="${a.preview}" alt="">`
    : `<span class="att-thumb att-ico" aria-hidden="true">${fileKind(a.file.type) === 'video' ? '▶'
        : fileKind(a.file.type) === 'audio' ? '♪' : '▤'}</span>`;
  tray.innerHTML = `<div class="att-chip"${a.busy ? ' data-busy="1"' : ''}>
    ${thumb}
    <span class="att-meta"><span class="att-name">${esc(a.file.name || 'attachment')}</span>
      <span class="att-size mono">${a.busy ? 'Sending ' + Math.round(a.pct * 100) + '%' : niceSize(a.file.size)}</span></span>
    <span class="att-bar" style="transform:scaleX(${a.busy ? a.pct : 0})" aria-hidden="true"></span>
    <button type="button" class="att-x" data-drop-att aria-label="Remove ${esc(a.file.name || 'this file')}">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"/></svg></button>
  </div>`;
  $('[data-drop-att]', tray).onclick = () => { clearAtt(which); };
}

function clearAtt(which) {
  const a = ATT[which];
  if (a?.preview) URL.revokeObjectURL(a.preview);
  ATT[which] = null;
  drawTray(which);
}

/* Stage a file rather than sending it straight away: you should see what you
   picked, be able to drop it, and be able to put a caption with it. */
function stageFile(which, file) {
  if (!file) return;
  if (file.size > FILE_MAX) {
    return toast('That file is too large', `${niceSize(file.size)} — the limit is 25 MB. Try a link for anything bigger.`);
  }
  if (!file.size) return toast('That file is empty', 'Nothing to send.');
  clearAtt(which);
  ATT[which] = {
    file, pct: 0, busy: false,
    preview: fileKind(file.type) === 'image' ? URL.createObjectURL(file) : null
  };
  drawTray(which);
  $(which === 'dm' ? '#dm-in' : '#composer').focus();
}

/* Take the first of a multi-select and say so, rather than dropping the rest
   silently — one attachment per message is the model everywhere else here. */
function stageFiles(which, list) {
  const files = [...(list || [])];
  if (!files.length) return;
  stageFile(which, files[0]);
  if (files.length > 1) toast('One at a time', `Sending ${esc(files[0].name)}. Attach the others after this one.`);
}

/* Send whatever is staged, with the typed text as its caption. Returns false
   when there was nothing staged, so the caller can fall through to a plain
   text message. */
async function sendStaged(which, body) {
  const a = ATT[which];
  if (!a || a.busy) return false;
  a.busy = true; a.pct = 0; drawTray(which);
  try {
    const up = await uploadFile(a.file, (p) => { a.pct = p; drawTray(which); });
    if (which === 'dm') await api('POST', `/api/dms/${DM.thread.id}/messages`, { body, fileId: up.id });
    else {
      const { message } = await api('POST', `/api/channels/${S.channel.id}/messages`, { body, fileId: up.id });
      upsertMessage(message);
    }
    clearAtt(which);
    return true;
  } catch (e) {
    a.busy = false; a.pct = 0; drawTray(which);
    toast('Not sent', e.message);
    throw e;
  }
}

/* how an attachment renders inside a bubble */
function fileHtml(f) {
  if (!f) return '';
  const src = `/api/files/${f.id}`, name = esc(f.name);
  switch (fileKind(f.mime)) {
    case 'image':
      return `<img class="msg-img" src="${src}" alt="${name}" loading="lazy" data-zoom>`;
    case 'video':
      return `<video class="msg-vid" src="${src}" controls preload="metadata" playsinline></video>`;
    case 'audio':
      return `<audio class="msg-aud" src="${src}" controls preload="metadata"></audio>`;
    default:
      return `<a class="msg-file" href="${src}" target="_blank" rel="noopener noreferrer" download="${name}">
        <span class="mf-ico" aria-hidden="true"><svg class="icon"><use href="#i-book"/></svg></span>
        <span class="mf-meta"><span class="mf-name">${name}</span>
          <span class="mf-size mono">${niceSize(f.size)} · download</span></span></a>`;
  }
}

/* Wire one composer: the + button, drag-and-drop onto the box, and paste.
   Paste matters most — a screenshot is the thing people actually share, and
   nobody wants to save it to disk first. */
function wireAttach(which, btnSel, inputSel, boxSel, dropSel) {
  const input = $(inputSel), box = $(boxSel), drop = $(dropSel);
  $(btnSel).onclick = () => input.click();
  input.onchange = () => { stageFiles(which, input.files); input.value = ''; };

  box.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;               // plain text paste, leave it alone
    e.preventDefault();
    stageFiles(which, files);
  });

  let depth = 0;
  drop.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault(); depth++; drop.dataset.filedrop = '1';
  });
  drop.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  });
  /* counted, because dragging over a child fires leave on the parent */
  drop.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; delete drop.dataset.filedrop; } });
  drop.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); depth = 0; delete drop.dataset.filedrop;
    stageFiles(which, e.dataTransfer.files);
  });
}

/* the chat composer: + button, drop anywhere on the message list, paste */
wireAttach('chat', '#attach-btn', '#attach-input', '#composer', '#v-chat');

/* reactions */
/* mirrors TASK_XP on the server, which is what actually gets awarded */
const TASK_XP = 5;

/* The first seven keys are the originals, so reactions already in the database
   keep rendering; the rest are new. Emoji rather than sprites because a reaction
   is meant to carry tone, which a monochrome icon cannot. */
const RX_EMOJI = {
  check: '\u2705', balloon: '\u{1F388}', flame: '\u{1F525}', target: '\u{1F3AF}',
  zap: '\u26A1', heart: '\u2764\uFE0F', branch: '\u{1F33F}',
  laugh: '\u{1F602}', wow: '\u{1F62E}', sad: '\u{1F622}', clap: '\u{1F44F}',
  think: '\u{1F914}', rocket: '\u{1F680}', eyes: '\u{1F440}', pray: '\u{1F64F}',
  brain: '\u{1F9E0}', bug: '\u{1F41B}', coffee: '\u2615', hundred: '\u{1F4AF}'
};
const RX_LABEL = {
  check: 'Done', balloon: 'Solved', flame: 'On fire', target: 'Exactly', zap: 'Fast',
  heart: 'Love', branch: 'Branched', laugh: 'Funny', wow: 'Wow', sad: 'Ouch',
  clap: 'Nice work', think: 'Thinking', rocket: 'Ship it', eyes: 'Looking',
  pray: 'Please', brain: 'Clever', bug: 'Bug', coffee: 'Late night', hundred: 'Perfect'
};
/* the row that opens first — the rest sit behind "more" */
const RX_QUICK = ['heart', 'laugh', 'wow', 'sad', 'clap', 'flame', 'check'];
const RX = Object.keys(RX_EMOJI);
$('#msgs').addEventListener('click', async (e) => {
  const cp = e.target.closest('[data-copy-code]');
  if (cp) {
    const pre = cp.closest('.msg-body')?.querySelector('.msg-code-h')?.nextElementSibling;
    const block = cp.parentElement.nextElementSibling;
    return copyText((block || pre)?.textContent || '', 'code block');
  }
  const chip = e.target.closest('.react');
  if (chip) return toggleReaction(chip.dataset.msg, chip.dataset.rx);
  /* the picker lives inside the message, so a click anywhere in it is handled here */
  const emoji = e.target.closest('.rx-opt');
  if (emoji) {
    toggleReaction(emoji.closest('.msg').dataset.msg, emoji.dataset.k);
    closePickers();
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {
    const bar = more.closest('.rx-bar');
    const open = bar.dataset.open === '1';
    bar.dataset.open = open ? '0' : '1';
    more.setAttribute('aria-expanded', String(!open));
    placeBar(bar.closest('.msg'));
    return;
  }
  /* the smile is the only way in: one click opens this message's emoji */
  const smile = e.target.closest('[data-smile]');
  if (smile) {
    const host = smile.closest('.msg');
    const was = host.hasAttribute('data-pick');
    $$('.msg[data-pick]').forEach(x => {
      x.removeAttribute('data-pick');
      x.querySelector('[data-smile]')?.setAttribute('aria-expanded', 'false');
    });
    if (!was) {
      placeBar(host);
      host.dataset.pick = '1';
      smile.setAttribute('aria-expanded', 'true');
    }
  }
});
function closePickers() {
  $$('.msg[data-pick]').forEach(x => {
    x.removeAttribute('data-pick');
    x.querySelector('[data-smile]')?.setAttribute('aria-expanded', 'false');
    const b = x.querySelector('.rx-bar');
    if (b) b.dataset.open = '0';
  });
}
document.addEventListener('click', (e) => { if (!e.target.closest('.rx-add')) closePickers(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closePickers(); });

/* The last messages sit against the composer, so a bar opening downward is
   clipped by the scroller. Measure the room before it is shown and flip it
   above the bubble when there is not enough. */
function placeBar(m) {
  const bar = m?.querySelector('.rx-bar');
  if (!bar) return;
  const sc = $('#chat-scroll').getBoundingClientRect();
  const body = m.querySelector('.msg-body').getBoundingClientRect();
  /* budget for the bar with its tray already open, so expanding cannot re-clip.
     Measured from the rendered rows rather than scrollHeight, which reads 0
     while the bar is still hidden. */
  const rowH = 34, trayRows = Math.ceil((RX.length - RX_QUICK.length) / 6);
  const need = rowH + trayRows * rowH + 22;
  bar.dataset.flip = (body.bottom + need > sc.bottom && body.top - need > sc.top) ? '1' : '0';
}

/* double-click anywhere on a bubble is the fastest way to a heart */
$('#msgs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-open-thread]');
  if (t) openThread(t.closest('.msg').dataset.msg);
});
$('#msgs').addEventListener('dblclick', (e) => {
  const m = e.target.closest('.msg');
  if (!m || e.target.closest('button, a, .vn')) return;
  const el2 = m.querySelector('.msg-body') || m;
  burstHeart(el2);
  toggleReaction(m.dataset.msg, 'heart');
});
/* a small flourish so the double-click is obviously registered */
function burstHeart(host) {
  const b = el('span', 'rx-burst', '\u2764\uFE0F');
  const r = host.getBoundingClientRect();
  b.style.left = (r.left + r.width / 2) + 'px';
  b.style.top = (r.top + r.height / 2) + 'px';
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 760);
}
async function toggleReaction(messageId, key) {
  try {
    const { reactions } = await api('POST', `/api/messages/${messageId}/reactions`, { key });
    const m = S.messages.find(x => x.id === messageId);
    if (m) {
      m.reactions = reactions;
      m.reacted = m.reacted.includes(key) ? m.reacted.filter(k => k !== key) : [...m.reacted, key];
      renderMessages();
    }
  } catch (e) { toast('Reaction failed', e.message); }
}


/* The POST reply and the websocket broadcast carry the same record and can
   arrive in either order — so applying either one is idempotent. */
function upsertMessage(m) {
  const i = S.messages.findIndex(x => x.id === m.id);
  if (i > -1) S.messages[i] = m; else S.messages.push(m);
  S.messages.sort((a, b) => a.created_at - b.created_at);
  renderMessages();
}
/* the POST reply and the websocket broadcast both carry the new channel —
   whichever lands first wins, the second is a no-op */
function upsertChannel(c) {
  const list = S.squad?.channels;
  if (!list) return c;
  const i = list.findIndex(x => x.id === c.id);
  if (i > -1) list[i] = { ...list[i], ...c }; else list.push(c);
  renderChannels();
  return list.find(x => x.id === c.id);
}
function upsertTask(t) {
  const i = S.tasks.findIndex(x => x.id === t.id);
  if (i > -1) S.tasks[i] = t; else S.tasks.push(t);
  renderBoard(); renderRoster();
}
function upsertEvent(e) {
  const i = S.events.findIndex(x => x.id === e.id);
  if (i > -1) S.events[i] = e; else S.events.push(e);
  renderCalendar(); renderRoster();
}

/* ---------------------------------------------------------- board */
const COLS = [['Backlog', 'var(--text-3)'], ['In progress', 'var(--azure)'], ['In review', 'var(--warn)'], ['Solved', 'var(--ok)']];
let boardFilter = 'all';

function renderBoard() {
  const visible = (t) =>
    boardFilter === 'private' ? !!t.owner_id
    : boardFilter === 'mine'  ? t.assignee_id === S.me.id
    : true;
  $('#board').innerHTML = COLS.map(([name, dot]) => {
    const items = S.tasks.filter(t => t.col === name && visible(t));
    return `<section class="col" data-col="${name}" aria-label="${name} column">
      <div class="col-h"><span class="col-dot" style="background:${dot}"></span><h3>${name}</h3><span class="col-n mono">${items.length}</span></div>
      <div class="col-list" data-drop="${name}">
        ${items.map(taskCard).join('') || '<p class="col-empty">Nothing here yet.</p>'}
      </div>
      <button class="col-add" data-add="${name}"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-plus"/></svg>Add task</button>
    </section>`;
  }).join('');
}

function taskCard(t) {
  const who = S.squad.members.find(m => m.id === t.assignee_id);
  const tags = (t.tags || '').split(' ').filter(Boolean);
  const priv = !!t.owner_id;
  return `<article class="card${priv ? ' card-priv' : ''}" tabindex="0" data-task="${t.id}" data-title="${esc(t.title)}">
    <div class="card-top"><span class="prio p-${t.priority}"></span><span class="card-t">${esc(t.title)}</span>
      <button class="card-more" aria-label="Actions for ${esc(t.title)}"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-more"/></svg></button></div>
    ${tags.length ? `<div class="card-tags">${tags.map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}
    <div class="card-foot">
      ${priv
        ? `<span class="card-lock" title="Only you can see this"><svg class="icon" aria-hidden="true"><use href="#i-lock"/></svg>Private</span>`
        : `<span class="card-xp"><svg class="icon" aria-hidden="true"><use href="#i-${t.col === 'Solved' ? 'check' : 'zap'}"/></svg>${t.xp}</span>`}
      ${t.due ? `<span class="card-due"><svg class="icon" aria-hidden="true"><use href="#i-cal"/></svg>${esc(t.due)}</span>` : ''}
      ${who ? avatar(who) : ''}
    </div></article>`;
}

$('#board').addEventListener('click', (e) => {
  const add = e.target.closest('.col-add');
  if (add) return taskDialog(add.dataset.add);
  const more = e.target.closest('.card-more');
  if (!more) return;
  const card = more.closest('.card');
  const task = S.tasks.find(t => t.id === card.dataset.task);
  const pop = el('div', 'pop', `<div class="pop-l">Move to</div>` +
    COLS.map(([n]) => `<button class="pop-i" data-to="${n}" ${n === task.col ? 'disabled' : ''}>
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-move"/></svg>${n}</button>`).join('') +
    `<div class="pop-sep"></div>` +
    `<button class="pop-i" data-priv="${task.owner_id ? '0' : '1'}">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-lock"/></svg>${task.owner_id ? 'Share with the squad' : 'Make private'}</button>` +
    `<button class="pop-i mm-danger" data-del><svg class="icon icon-sm" aria-hidden="true"><use href="#i-x"/></svg>Delete task</button>`);
  document.body.appendChild(pop);
  const r = more.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + 'px';
  pop.style.top = (r.bottom + pop.offsetHeight > innerHeight - 8 ? r.top - pop.offsetHeight - 6 : r.bottom + 6) + 'px';
  const close = () => { pop.remove(); document.removeEventListener('pointerdown', out, true); };
  const out = (ev) => { if (!pop.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', out, true), 0);
  $$('.pop-i', pop).forEach(b => b.onclick = async () => {
    close();
    if (b.hasAttribute('disabled')) return;
    if (b.hasAttribute('data-del')) return deleteTask(task.id);
    if (b.hasAttribute('data-priv')) return setTaskPrivate(task, b.dataset.priv === '1');
    moveTask(task.id, b.dataset.to);
  });
});

async function setTaskPrivate(task, priv) {
  try {
    const { task: next, xpDelta } = await api('PATCH', `/api/tasks/${task.id}`, { private: priv });
    upsertTask(next);
    if (xpDelta) refreshXp();
    toast(priv ? 'Moved to your own list' : 'Shared with the squad',
      priv ? 'Nobody else in the squad can see it now. Private tasks pay no XP.'
           : `Everyone can see it. Worth ${TASK_XP} XP when it reaches Solved.`, 'ok');
  } catch (e) { toast('Could not change that', e.message); }
}

/* keyboard move, the alternative to dragging */
$('#board').addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (!card || !e.key.startsWith('Arrow')) return;
  const task = S.tasks.find(t => t.id === card.dataset.task);
  const i = COLS.findIndex(([n]) => n === task.col);
  const next = e.key === 'ArrowRight' ? COLS[i + 1] : e.key === 'ArrowLeft' ? COLS[i - 1] : null;
  if (!next) return;
  e.preventDefault();
  moveTask(task.id, next[0]);
});

/* pointer drag on fine pointers */
if (matchMedia('(pointer:fine)').matches) {
  let drag = null;
  $('#board').addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.card');
    if (!card || e.target.closest('.card-more')) return;
    drag = { card, id: card.dataset.task, from: card.closest('[data-drop]').dataset.drop, x: e.clientX, y: e.clientY, live: false };
  });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.live) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 7) return;
      drag.live = true;
      drag.card.classList.add('dragging');
    }
    e.preventDefault();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const list = under?.closest?.('[data-drop]');
    $$('.col').forEach(c => c.classList.remove('over'));
    if (list) list.closest('.col').classList.add('over');
    drag.to = list?.dataset.drop;
  }, { passive: false });
  addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag; drag = null;
    $$('.col').forEach(c => c.classList.remove('over'));
    d.card.classList.remove('dragging');
    if (d.live && d.to && d.to !== d.from) moveTask(d.id, d.to);
  });
}

async function moveTask(id, col) {
  try {
    const { task, xpDelta } = await api('PATCH', `/api/tasks/${id}`, { col });
    upsertTask(task);
    if (xpDelta) {
      await refreshXp();
      toast(xpDelta > 0 ? `+${xpDelta} XP` : `${xpDelta} XP`, task.title, xpDelta > 0 ? 'ok' : undefined);
    } else toast('Moved to ' + col, task.title, 'ok');
  } catch (e) { toast('Could not move that task', e.message); }
}
async function deleteTask(id) {
  try { await api('DELETE', `/api/tasks/${id}`); S.tasks = S.tasks.filter(t => t.id !== id); renderBoard(); renderRoster(); }
  catch (e) { toast('Could not delete', e.message); }
}

$('#add-task').onclick = () => taskDialog('Backlog');
function taskDialog(col) {
  if (!S.squad) return toast('Create a squad first', 'Tasks live inside a squad.');
  modal('New task', `
    <div class="fld"><label for="t-title">What needs doing?</label><input id="t-title" type="text"></div>
    <div class="fld"><label for="t-prio">Priority</label><select id="t-prio"><option value="lo">Low</option><option value="md" selected>Medium</option><option value="hi">High</option></select></div>
    <div class="fld"><label for="t-who">Assign to</label><select id="t-who">
      <option value="">Nobody yet</option>
      ${S.squad.members.map(m => `<option value="${m.id}" ${m.id === S.me.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
    </select></div>
    <div class="fld"><label for="t-tags">Tags <span class="wz-opt">space separated</span></label><input id="t-tags" type="text" placeholder="geometry dp"></div>
    <label class="t-priv"><input type="checkbox" id="t-priv">
      <span><b>Keep this one to myself</b>
        <span class="t-priv-h">It stays on your own list — nobody else in the squad sees it, and it pays no XP.</span></span></label>
    <p class="fld-help" id="t-xp-note">Every shared task is worth <b>${TASK_XP} XP</b>, paid out when it reaches Solved.</p>
    <p class="gate-error" id="t-err" hidden></p>
    <button class="btn btn-primary btn-lg" id="t-go" style="width:100%;justify-content:center">Add to ${esc(col)}</button>`,
  (m, close) => {
    $('#t-title', m).focus();
    /* nobody else can see a private task, so there is nobody else to give it to */
    $('#t-priv', m).onchange = (e) => {
      const on = e.target.checked;
      $('#t-who', m).disabled = on;
      if (on) $('#t-who', m).value = S.me.id;
      $('#t-xp-note', m).hidden = on;
    };
    $('#t-go', m).onclick = async () => {
      try {
        const priv = $('#t-priv', m).checked;
        const { task } = await api('POST', `/api/squads/${S.squad.id}/tasks`, {
          title: $('#t-title', m).value, col,
          priority: $('#t-prio', m).value, tags: $('#t-tags', m).value.trim(),
          assignee_id: priv ? S.me.id : ($('#t-who', m).value || null),
          private: priv
        });
        upsertTask(task); close();
        toast('Task added', task.title, 'ok');
      } catch (e) { $('#t-err', m).textContent = e.message; $('#t-err', m).hidden = false; }
    };
  });
}

$$('[data-filter]').forEach(b => b.onclick = () => {
  boardFilter = b.dataset.filter;
  $$('[data-filter]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderBoard();
});

/* ---------------------------------------------------------- xp */
async function refreshXp() {
  const me = await api('GET', '/api/me');
  S.xp = me.xp; S.ledger = me.ledger;
  renderXp(); loadStandings();
}
function renderXp() {
  const { total, level, floor, ceil } = S.xp;
  const pct = Math.max(0, Math.min(1, (total - floor) / (ceil - floor)));
  $('#ring-n').textContent = level;
  $('#ring-arc').setAttribute('stroke-dashoffset', (326.7 * (1 - pct)).toFixed(1));
  $('#xp-total').textContent = total.toLocaleString();
  $('#xp-togo').textContent = (ceil - total).toLocaleString();
  $('#xp-bar').style.width = (pct * 100).toFixed(1) + '%';
  $('#me-lvl').textContent = `Lv ${level} · ${total.toLocaleString()} XP`;
  $('#ledger').innerHTML = S.ledger.length ? S.ledger.map(l => `
    <div class="led"><span class="led-ic"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-${l.amount > 0 ? 'check' : 'move-l'}"/></svg></span>
      <div class="led-b"><div class="led-t">${esc(l.reason)}</div>
      <div class="led-s">${new Date(l.created_at).toLocaleString()}</div></div>
      <span class="led-v mono${l.amount > 0 ? '' : ' neg'}">${l.amount > 0 ? '+' : '−'}${Math.abs(l.amount)}</span></div>`).join('')
    : '<p class="col-empty">No XP yet. Solve a task on the board.</p>';
}
async function loadStandings() {
  const { standings } = await api('GET', '/api/standings');
  $('#lb-body').innerHTML = standings.map((u, i) => `
    <tr${u.id === S.me.id ? ' class="me"' : ''}><td class="rank mono${i < 3 ? ' top' : ''}">${i + 1}</td>
    <td><div class="who">${avatar(u)}<div style="min-width:0"><div class="who-n">${esc(u.name)}${u.id === S.me.id ? ' <span class="chip c-gold">You</span>' : ''}</div>
    <div class="who-h mono">${esc(u.handle)}</div></div></div></td>
    <td class="num">${Number(u.xp).toLocaleString()}</td></tr>`).join('');
}

/* ---------------------------------------------------------- calendar */
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

function renderCalendar() {
  const base = S.calMonth ? new Date(S.calMonth) : new Date();
  base.setDate(1);
  S.calMonth = base.getTime();
  $('#cal-month').textContent = base.toLocaleDateString([], { month: 'long', year: 'numeric' });

  const start = new Date(base);
  start.setDate(1 - ((base.getDay() + 6) % 7));
  const byDay = {};
  S.events.forEach(e => { (byDay[dayKey(e.starts_at)] ||= []).push(e); });
  const todayKey = dayKey(Date.now());
  if (!S.calDay) S.calDay = todayKey;

  let cells = `<div class="cdows" role="row">${DOW.map(d => `<span class="cdow">${d}</span>`).join('')}</div>`;
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = dayKey(d), evs = byDay[k] || [];
    const out = d.getMonth() !== base.getMonth() ? ' out' : '';
    cells += `<button class="cday${out}${k === todayKey ? ' today' : ''}" data-d="${k}" aria-pressed="${k === S.calDay}"
      aria-label="${d.toLocaleDateString([], { day: 'numeric', month: 'long' })}, ${evs.length} item${evs.length === 1 ? '' : 's'}">
      <span class="cnum mono">${d.getDate()}</span>
      <span class="cdots">${evs.slice(0, 3).map(e => `<i class="d-${e.kind === 'meeting' ? 'event' : e.kind}"></i>`).join('')}</span></button>`;
  }
  $('#cgrid').innerHTML = cells;
  renderAgenda();
}

function renderAgenda() {
  const items = S.events.filter(e => dayKey(e.starts_at) === S.calDay).sort((a, b) => a.starts_at - b.starts_at);
  $('#agenda-title').textContent = new Date(S.calDay + 'T00:00:00')
    .toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  $('#agenda').innerHTML = items.length ? items.map(e => `
    <div class="ag ag-${e.kind === 'meeting' ? 'event' : e.kind}">
      <span class="ag-t mono">${new Date(e.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="ag-ic"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-${e.kind === 'meeting' ? 'mic' : e.kind === 'contest' ? 'trophy' : e.kind === 'deadline' ? 'clock' : 'users'}"/></svg></span>
      <span class="ag-b"><span class="ag-title">${esc(e.title)}</span>
        <span class="ag-meta mono">${e.duration} min${e.meeting_id ? ' · meeting' : ''}</span>
        ${e.meeting_id ? `<button class="btn btn-sm" data-join="${e.meeting_id}" style="margin-top:6px">Join</button>` : ''}</span>
    </div>`).join('') : '<p class="agenda-empty">Nothing scheduled. <span class="mono">Good day to upsolve.</span></p>';
}

$('#cgrid').addEventListener('click', (e) => {
  const d = e.target.closest('.cday');
  if (!d) return;
  S.calDay = d.dataset.d;
  $$('.cday').forEach(x => x.setAttribute('aria-pressed', String(x === d)));
  renderAgenda();
});
$('#agenda').addEventListener('click', (e) => {
  const j = e.target.closest('[data-join]');
  if (j) joinMeeting(j.dataset.join);
});
$('#cal-prev').onclick = () => { const d = new Date(S.calMonth); d.setMonth(d.getMonth() - 1); S.calMonth = d.getTime(); renderCalendar(); };
$('#cal-next').onclick = () => { const d = new Date(S.calMonth); d.setMonth(d.getMonth() + 1); S.calMonth = d.getTime(); renderCalendar(); };
$('#schedule-meeting').onclick = () => meetingDialog(S.calDay);

function meetingDialog(onDay) {
  if (!S.squad) return toast('Create a squad first', 'Meetings belong to a squad.');
  const d = new Date((onDay || dayKey(Date.now())) + 'T19:00');
  const localValue = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  modal('Schedule a meeting', `
    <p class="modal-sub">This creates a room your squad can join, and puts it on the calendar.</p>
    <div class="fld"><label for="mt-title">What is it for?</label><input id="mt-title" type="text" value="Squad meeting"></div>
    <div class="fld-row">
      <div class="fld"><label for="mt-when">Starts</label><input id="mt-when" type="datetime-local" value="${localValue}"></div>
      <div class="fld"><label for="mt-dur">Minutes</label><input id="mt-dur" type="number" min="15" step="15" value="60"></div>
    </div>
    <p class="gate-error" id="mt-err" hidden></p>
    <div class="fld-row">
      <button class="btn btn-lg" id="mt-later" style="flex:1;justify-content:center">Put on calendar</button>
      <button class="btn btn-primary btn-lg" id="mt-now" style="flex:1;justify-content:center">Start now</button>
    </div>`,
  (m, close) => {
    const make = async (startNow) => {
      try {
        const when = startNow ? Date.now() : new Date($('#mt-when', m).value).getTime();
        const { meeting, event } = await api('POST', `/api/squads/${S.squad.id}/meetings`, {
          title: $('#mt-title', m).value, starts_at: when, duration: Number($('#mt-dur', m).value) || 60
        });
        upsertEvent(event); close();
        if (startNow) joinMeeting(meeting.id);
        else toast('Meeting scheduled', new Date(when).toLocaleString(), 'ok');
      } catch (e) { $('#mt-err', m).textContent = e.message; $('#mt-err', m).hidden = false; }
    };
    $('#mt-now', m).onclick = () => make(true);
    $('#mt-later', m).onclick = () => make(false);
  });
}
$('#start-meeting').onclick = () => meetingDialog(dayKey(Date.now()));

/* ---------------------------------------------------------- meetings (WebRTC mesh) */
const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }] };
const M = { id: null, local: null, screen: null, peers: new Map(), mic: true, cam: true, sharing: false };

/* The room must survive anything that is not fatal: a denied camera, a socket
   still connecting, a laptop with no webcam. Only a meeting we could never open
   closes the overlay. */
function waitForSocket(ms = 6000) {
  return new Promise((resolve) => {
    if (S.ws?.readyState === 1) return resolve(true);
    if (!S.ws || S.ws.readyState > 1) openSocket();
    const started = Date.now();
    const tick = setInterval(() => {
      if (S.ws?.readyState === 1) { clearInterval(tick); resolve(true); }
      else if (Date.now() - started > ms) { clearInterval(tick); resolve(false); }
    }, 120);
  });
}

async function mediaReason(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    let siteAllowed = null;
    try { siteAllowed = (await navigator.permissions.query({ name: 'camera' })).state; } catch {}
    if (siteAllowed === 'granted')
      return ['Your browser has no camera access', 'macOS is blocking it: System Settings → Privacy & Security → Camera, switch your browser on, then reopen it.'];
    return ['Camera or microphone was blocked', 'Click the icon at the left of the address bar and allow them — if it says "give access in system settings", it is macOS blocking the browser itself.'];
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError')
    return ['No camera or microphone found', 'You are in the room and can still see and hear everyone.'];
  if (n === 'NotReadableError')
    return ['Your camera is busy', 'Another app is using it. Close that, then press Camera to try again.'];
  return ['Could not start your camera', err?.message || 'Press Camera to try again.'];
}

/* Acquire (or re-acquire) media and push the new tracks to everyone already here. */
/* Browsers only expose navigator.mediaDevices on a secure origin. Over plain
   http on a LAN address the object is not merely empty, it is undefined — so
   the old code threw "Cannot read properties of undefined (reading
   'getUserMedia')" and put that straight in front of the user. */
function mediaBlocked() {
  if (window.isSecureContext && navigator.mediaDevices?.getUserMedia) return null;
  const https = (S.net?.public || '').replace(/\/$/, '');
  return {
    title: 'This address cannot reach your camera',
    detail: https
      ? `Browsers only allow camera and microphone over https. Open ${https} instead — everything else here works the same.`
      : 'Browsers only allow camera and microphone over https or on localhost. Ask whoever is hosting for the https link.',
    link: https
  };
}

async function acquireMedia(want) {
  const blocked = mediaBlocked();
  if (blocked) { showMediaBlocked(blocked); return false; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia(want); }
  catch (err) {
    const [t, sub] = await mediaReason(err);
    toast(t, sub);
    return false;
  }
  if (!M.local) M.local = new MediaStream();
  for (const track of stream.getTracks()) {
    const old = M.local.getTracks().find(x => x.kind === track.kind);
    if (old) { M.local.removeTrack(old); old.stop(); }
    M.local.addTrack(track);
    /* replace on existing senders, or add if this kind was never sent */
    M.peers.forEach(pc => {
      const sender = pc.getSenders().find(x => x.track?.kind === track.kind);
      if (sender) sender.replaceTrack(track);
      else pc.addTrack(track, M.local);
    });
  }
  if (want.video) M.cam = true;
  if (want.audio) M.mic = true;
  renderSelfTile();
  syncMediaButtons();
  if (M.id) publishState();
  return true;
}

/* Who is in the room, independent of whether their media has arrived. A tile
   used to appear only when ontrack fired, so anyone who joined with the camera
   and mic off stayed invisible and the count was wrong. */
const roster = new Map();   /* peerId -> { name, handle, cam, mic, self } */

function renderWho() {
  const rows = [...roster.entries()];
  $('#meet-count').textContent = `${rows.length} in the room`;
  $('#meet-who-list').innerHTML = rows.map(([id, p]) => `
    <div class="who-row">
      <span class="av av-m" style="background:${tint(id)}">${esc(initials(p.name))}</span>
      <span class="who-b"><span class="who-n">${esc(p.name)}${p.self ? ' <i>(you)</i>' : ''}${
        p.guest ? '<span class="who-guest">guest</span>' : ''}</span>
        <span class="who-s mono">${esc(p.handle || '')}</span></span>
      <span class="who-ic" data-on="${p.mic ? '1' : '0'}" title="${p.mic ? 'mic on' : 'muted'}">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-mic"/></svg></span>
      <span class="who-ic" data-on="${p.cam ? '1' : '0'}" title="${p.cam ? 'camera on' : 'camera off'}">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-users"/></svg></span>
      <button class="who-pin" data-pin="${id}" aria-pressed="${M.pinned === id}"
        aria-label="${M.pinned === id ? 'Unpin' : 'Pin'} ${esc(p.name)}" title="${M.pinned === id ? 'Unpin' : 'Pin to my screen'}">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-pin"/></svg></button>
    </div>`).join('');
  $$('[data-pin]', $('#meet-who-list')).forEach(b => b.onclick = () => setPin(b.dataset.pin));
}

function setPresence(peerId, patch) {
  const cur = roster.get(peerId) || { name: 'Guest', handle: '', cam: false, mic: false };
  roster.set(peerId, { ...cur, ...patch });
  const p = roster.get(peerId);
  /* a tile the moment they arrive — media or not */
  addTile(peerId, p.self ? p.name + (M.sharing ? ' (sharing)' : ' (you)') : p.name,
    peerId === 'self' ? (M.sharing ? M.screen : M.local) : M.peers.get(peerId)?.remote, peerId === 'self');
  renderWho();
}

/* let the others see what you have switched on */
function publishState() {
  setPresence('self', { cam: !!(M.cam && M.local?.getVideoTracks().length) || M.sharing, mic: !!(M.mic && M.local?.getAudioTracks().length) });
  safeSend({ type: 'meeting-state', state: { cam: !!(M.cam && M.local?.getVideoTracks().length) || M.sharing, mic: !!(M.mic && M.local?.getAudioTracks().length), name: S.me?.name, handle: S.me?.handle } });
}

function renderSelfTile() {
  addTile('self', S.me.name + (M.sharing ? ' (sharing)' : ' (you)'), M.sharing ? M.screen : M.local, true);
}

function syncMediaButtons() {
  const hasCam = !!M.local?.getVideoTracks().length;
  const hasMic = !!M.local?.getAudioTracks().length;
  const cam = $('#meet-cam'), mic = $('#meet-mic');
  /* never disabled — with no track these become "turn it on" */
  cam.disabled = mic.disabled = false;
  cam.setAttribute('aria-pressed', String(hasCam && M.cam));
  mic.setAttribute('aria-pressed', String(hasMic && M.mic));
  cam.querySelector('span').textContent = !hasCam ? 'Turn on camera' : M.cam ? 'Camera' : 'Camera off';
  mic.querySelector('span').textContent = !hasMic ? 'Turn on mic' : M.mic ? 'Mute' : 'Unmute';
}

/* A toast disappears; the reason this room has no camera should stay put. */
function showMediaBlocked(b) {
  toast(b.title, b.detail);
  const bar = $('#meet-warn');
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = `<span>${esc(b.detail)}</span>` +
    (b.link ? `<button class="btn btn-sm" data-copy-https>Copy the https link</button>` : '');
  $('[data-copy-https]', bar)?.addEventListener('click', () => copyText(b.link, 'the https link'));
}

async function joinMeeting(meetingId, pass) {
  let meeting, squad, guest;
  try {
    ({ meeting, squad, guest } = await api('GET',
      `/api/meetings/${meetingId}${pass ? '?pass=' + encodeURIComponent(pass) : ''}`));
  } catch (e) {
    toast('Could not open that meeting', e.message);
    return;
  }
  /* the pass came in on the link and is needed again for the socket join */
  M.pass = pass || meeting.pass || null;
  M.guest = !!guest;

  /* a meeting link can point at any squad you are in, not just the open one */
  if (squad && S.squad?.id !== squad.id && S.squads.some(x => x.id === squad.id)) {
    await openSquad(squad.id);
  }

  M.id = meeting.id;
  $('#meet-title').textContent = meeting.title;
  $('#meet').hidden = false;
  $('#meet-warn').hidden = true;
  const blocked = mediaBlocked();
  roster.clear();
  roster.set('self', { name: S.me.name, handle: S.me.handle, cam: false, mic: false, self: true });
  renderSelfTile();
  renderWho();
  syncMediaButtons();

  if (blocked) showMediaBlocked(blocked);
  else await acquireMedia({ video: true, audio: true });

  const live = await waitForSocket();
  if (!live) {
    toast('Still connecting', 'You are in the room — others will appear when the connection settles.');
    return;
  }
  try { S.ws.send(JSON.stringify({ type: 'meeting-join', meetingId: M.id, pass: M.pass || undefined })); }
  catch { toast('Still connecting', 'Others will appear in a moment.'); }
}

function addTile(id, label, stream, muted) {
  let tile = $(`[data-tile="${id}"]`);
  if (!tile) {
    tile = el('div', 'meet-tile');
    tile.dataset.tile = id;
    tile.innerHTML = `<video autoplay playsinline${muted ? ' muted' : ''}></video><span class="meet-name"></span>
      <button class="meet-pin" data-pin="${id}" aria-pressed="false">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-pin"/></svg><span>Pin</span></button>`;
    $('#meet-grid').appendChild(tile);
  }
  $('.meet-name', tile).textContent = label;
  const v = $('video', tile);
  if (stream && v.srcObject !== stream) { v.srcObject = stream; v.play?.().catch(() => {}); }
  const live = !!stream?.getVideoTracks?.().some(t => t.enabled && t.readyState === 'live');
  tile.classList.toggle('no-video', !live);
  let off = $('.meet-off', tile);
  if (!live) {
    if (!off) { off = el('span', 'meet-off', `<span class="meet-initials"></span><span class="meet-off-t"></span>`); tile.appendChild(off); }
    $('.meet-initials', off).textContent = initials(label);
    $('.meet-off-t', off).textContent = id === 'self' && !M.local?.getVideoTracks().length ? 'no camera' : 'camera off';
  } else off?.remove();
  applyPin();
  updateCount();
  return tile;
}
const updateCount = () => { if (roster.size) renderWho(); };

/* ---- pinning ----
   Whose face fills your screen is your business, not the room's: it is held on
   the client and never told to anyone else, so two people can be watching
   different things at the same time. */
function setPin(id) {
  M.pinned = (M.pinned === id) ? null : id;
  applyPin();
  renderWho();
  if (M.pinned) {
    const p = roster.get(M.pinned);
    toast('Pinned ' + (p?.self ? 'yourself' : (p?.name || 'them')), 'Tap the pin again to go back to the grid', 'ok');
  }
}

function applyPin() {
  const grid = $('#meet-grid');
  if (!grid) return;
  /* the pinned peer may have left while pinned */
  if (M.pinned && !$(`[data-tile="${M.pinned}"]`)) M.pinned = null;
  grid.toggleAttribute('data-pinned', !!M.pinned);
  $$('.meet-tile', grid).forEach(t => {
    const on = t.dataset.tile === M.pinned;
    t.classList.toggle('pinned', on);
    const b = $('.meet-pin', t);
    if (b) {
      b.setAttribute('aria-pressed', String(on));
      $('span', b).textContent = on ? 'Unpin' : 'Pin';
      b.setAttribute('aria-label', (on ? 'Unpin ' : 'Pin ') + ($('.meet-name', t)?.textContent || 'this person'));
    }
  });
}

$('#meet-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pin]');
  if (b) setPin(b.dataset.pin);
});

function peerFor(peerId, name) {
  if (M.peers.has(peerId)) return M.peers.get(peerId);
  const pc = new RTCPeerConnection(ICE);
  M.peers.set(peerId, pc);
  pc.remote = new MediaStream();
  pc.label = name || 'Guest';
  M.local?.getTracks().forEach(t => pc.addTrack(t, M.local));
  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(t => { if (!pc.remote.getTracks().includes(t)) pc.remote.addTrack(t); });
    addTile(peerId, pc.label, pc.remote);
  };
  pc.onicecandidate = (e) => { if (e.candidate) safeSend({ type: 'ice', to: peerId, candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(peerId);
  };
  return pc;
}
function safeSend(obj) { try { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(obj)); } catch {} }
function dropPeer(peerId) {
  M.peers.get(peerId)?.close();
  M.peers.delete(peerId);
  $(`[data-tile="${peerId}"]`)?.remove();
  roster.delete(peerId);
  if (M.pinned === peerId) { M.pinned = null; toast('They left', 'Back to the grid'); }
  applyPin();
  renderWho();
}

async function handleSignal(msg) {
  if (!M.id) return;
  try {
    if (msg.type === 'meeting-refused') {
      toast('Could not join that meeting', 'The link is no longer valid, or the call has ended.');
      return;
    }
    if (msg.type === 'meeting-peers') {
      /* everyone already here — show them before a single track arrives */
      for (const p of msg.peers) setPresence(p.peerId, { name: p.name, handle: p.handle, guest: !!p.guest });
      if (msg.peers.length) toast(`${msg.peers.length} already here`,
        msg.peers.map(p => p.name.split(' ')[0]).join(', '), 'ok');
      for (const p of msg.peers) {
        const pc = peerFor(p.peerId, p.name);
        await pc.setLocalDescription(await pc.createOffer());
        safeSend({ type: 'offer', to: p.peerId, sdp: pc.localDescription });
      }
      publishState();
      return;
    }
    if (msg.type === 'meeting-joined') {
      setPresence(msg.peerId, { name: msg.name, handle: msg.handle, guest: !!msg.guest });
      toast(msg.name + ' joined', msg.guest ? 'Joined with the link — not a squad member' : 'Meeting', 'ok');
      publishState();             /* tell the newcomer what you have on */
      return;
    }
    if (msg.type === 'meeting-state') {
      if (roster.has(msg.peerId) || msg.name)
        setPresence(msg.peerId, { cam: !!msg.cam, mic: !!msg.mic, ...(msg.name ? { name: msg.name, handle: msg.handle } : {}) });
      return;
    }
    if (msg.type === 'offer') {
      setPresence(msg.from, { name: msg.name, handle: msg.handle });
      const pc = peerFor(msg.from, msg.name);
      await pc.setRemoteDescription(msg.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      safeSend({ type: 'answer', to: msg.from, sdp: pc.localDescription });
      return;
    }
    if (msg.type === 'answer') { await M.peers.get(msg.from)?.setRemoteDescription(msg.sdp); return; }
    if (msg.type === 'ice') { try { await M.peers.get(msg.from)?.addIceCandidate(msg.candidate); } catch {} return; }
    if (msg.type === 'meeting-left') {
      const gone = roster.get(msg.peerId);
      if (gone) toast(gone.name + ' left', 'Meeting');
      dropPeer(msg.peerId);
      return;
    }
  } catch (e) {
    /* a failed negotiation with one peer must not take the room down */
    console.warn('[meeting]', msg.type, e);
  }
}

$('#meet-mic').onclick = async () => {
  const track = M.local?.getAudioTracks()[0];
  if (!track) return void acquireMedia({ audio: true });
  M.mic = !M.mic; track.enabled = M.mic;
  syncMediaButtons(); publishState();
};
$('#meet-cam').onclick = async () => {
  const track = M.local?.getVideoTracks()[0];
  if (!track) return void acquireMedia({ video: true });
  M.cam = !M.cam; track.enabled = M.cam;
  renderSelfTile(); syncMediaButtons(); publishState();
};
$('#meet-share').onclick = async () => {
  try {
    if (M.sharing) {
      M.screen?.getTracks().forEach(t => t.stop());
      M.screen = null; M.sharing = false;
      const cam = M.local?.getVideoTracks()[0] || null;
      M.peers.forEach(pc => pc.getSenders().find(s => s.track?.kind === 'video')?.replaceTrack(cam));
    } else {
      const blocked = mediaBlocked();
      if (blocked) { showMediaBlocked(blocked); return; }
      M.screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      M.sharing = true;
      const track = M.screen.getVideoTracks()[0];
      M.peers.forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        sender ? sender.replaceTrack(track) : pc.addTrack(track, M.screen);
      });
      track.onended = () => { if (M.sharing) $('#meet-share').click(); };
    }
    $('#meet-share').setAttribute('aria-pressed', String(M.sharing));
    $('#meet-share').querySelector('span').textContent = M.sharing ? 'Stop sharing' : 'Share screen';
    renderSelfTile(); publishState();
  } catch (e) {
    if (e?.name !== 'NotAllowedError') toast('Screen share failed', e.message);
  }
};
$('#meet-copy').onclick = async () => {
  /* The addresses were read once at boot. A tunnel can be opened — or die —
     long after that, and the stale answer is what decides whether the link
     you are about to send can carry a camera at all. So ask again. */
  S.net = await api('GET', '/api/net').catch(() => S.net);

  /* The pass is what makes this work for someone outside the squad — without
     it the link only opens for people who are already members, which is not
     what anyone means by "here is the link to the call". */
  const base = shareBase();
  const link = `${base}/?meeting=${M.id}` + (M.pass ? `&pass=${encodeURIComponent(M.pass)}` : '');
  const kind = reachKind(base);
  const secure = /^https:/.test(base) || reachKind(base) === 'local';

  try { await navigator.clipboard.writeText(link); } catch { return toast('Copy this link', link); }

  /* Camera and microphone are blocked outside a secure context, so a plain http
     link is not a meeting link — it is a page the other person will sit on with
     no way to turn anything on. Say so instead of calling it copied and done. */
  if (!secure) {
    toast('Copied — but their camera will not work',
      `This is a plain http address, and browsers block camera and microphone on those. ` +
      `Start the tunnel (npm run tunnel) and copy again to get an https link.`);
  } else if (kind === 'lan') {
    toast('Copied — same wifi only',
      'This address points at your laptop, so they have to be on your network. They will see a certificate warning once.', 'ok');
  } else if (kind === 'local') {
    toast('Copied — but only this computer can open it',
      'Squadron is running on your laptop with no tunnel, so nobody else can reach this link yet.');
  } else {
    toast('Meeting link copied',
      M.pass ? 'Anyone you send this to can join the call, camera and mic included. They will not get the rest of the squad.'
             : 'Camera and mic will work for them.', 'ok');
  }
};
$('#meet-leave').onclick = leaveMeeting;
$('#meet-count').onclick = () => {
  const w = $('#meet-who');
  w.hidden = !w.hidden;
  $('#meet-count').setAttribute('aria-expanded', String(!w.hidden));
};
$('#meet-who-x').onclick = () => { $('#meet-who').hidden = true; $('#meet-count').setAttribute('aria-expanded', 'false'); };
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#meet').hidden) leaveMeeting(); });

function leaveMeeting() {
  safeSend({ type: 'meeting-leave' });
  M.peers.forEach(pc => pc.close());
  M.peers.clear();
  M.local?.getTracks().forEach(t => t.stop());
  M.screen?.getTracks().forEach(t => t.stop());
  M.local = M.screen = null; M.id = null; M.sharing = false; M.cam = M.mic = true;
  M.pinned = null;
  roster.clear();
  $('#meet-who').hidden = true;
  $('#meet-count').setAttribute('aria-expanded', 'false');
  $('#meet-grid').innerHTML = '';
  $('#meet').hidden = true;
  $('#meet-share').setAttribute('aria-pressed', 'false');
  $('#meet-share').querySelector('span').textContent = 'Share screen';
}

/* ------------------------------------------------------ channel wizard */
/* A spread of symbols that read well at 14px on a dark sidebar. The field
   below stays free-text, so anything the OS emoji picker offers works too. */
const CHAN_SYMBOLS = [
  '#', '\u{1F4AC}', '\u{1F4E3}', '\u{1F4CC}', '\u{1F4DD}', '\u{1F4C1}', '\u{1F4CA}',
  '\u{1F9E9}', '\u{1F528}', '\u{1F41B}', '\u{1F50D}', '\u{1F680}', '\u{26A1}', '\u{1F525}',
  '\u{1F3AF}', '\u{1F388}', '\u{1F3C6}', '\u{1F4DA}', '\u{2600}\u{FE0F}', '\u{1F319}',
  '\u{2699}\u{FE0F}', '\u{1F517}', '\u{1F4C5}', '\u{2764}\u{FE0F}', '\u{2605}', '\u{25C6}',
  '\u{203B}', '\u{00A7}', '\u{2318}', '\u{03BB}'
];

function deleteChannelDialog(id, name) {
  const ch = S.squad?.channels.find(c => c.id === id);
  modal('Delete #' + name, `
    <div class="set-why">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-info"/></svg>
      <p>Deletes <b>#${esc(name)}</b> for the whole squad, along with every message in it —
         including voice notes, shared code and pictures. Pins and mentions go with it.
         <b>There is no undo.</b></p>
    </div>
    <div class="fld"><label for="dc-confirm">Type <b>${esc(name)}</b> to confirm</label>
      <input id="dc-confirm" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(name)}"></div>
    <p class="gate-error" id="dc-err" hidden></p>
    <div class="set-row">
      <button class="btn" data-cancel style="flex:1;justify-content:center">Keep it</button>
      <button class="btn btn-quiet-danger" id="dc-go" style="flex:1;justify-content:center" disabled>Delete the channel</button>
    </div>`,
  (m, close) => {
    const input = $('#dc-confirm', m), go = $('#dc-go', m);
    input.oninput = () => { go.disabled = input.value.trim() !== name; };
    $('[data-cancel]', m).onclick = close;
    setTimeout(() => input.focus(), 80);
    go.onclick = async () => {
      go.disabled = true;
      try {
        const r = await api('DELETE', `/api/channels/${id}`);
        close();
        toast('#' + name + ' deleted', `${r.messagesRemoved} message${r.messagesRemoved === 1 ? '' : 's'} went with it.`, 'ok');
      } catch (e) { $('#dc-err', m).textContent = e.message; $('#dc-err', m).hidden = false; go.disabled = false; }
    };
  });
}

function openChannelWizard() {
  if (!S.squad) return;
  let icon = '\u{1F4AC}';

  modal('New channel', `
    <div class="fld"><label for="cw-name">Channel name</label>
      <input id="cw-name" maxlength="32" placeholder="contest-prep" autocomplete="off">
      <p class="fld-help">Lowercase, no spaces — anything else is converted for you.</p></div>

    <div class="fld"><label>Symbol</label>
      <div class="sym-grid" id="cw-grid">
        ${CHAN_SYMBOLS.map(x => `<button type="button" class="sym" data-sym="${esc(x)}"
          ${x === icon ? 'aria-pressed="true"' : 'aria-pressed="false"'}>${esc(x)}</button>`).join('')}
      </div>
      <div class="sym-own"><label for="cw-own" class="fld-help">Or type your own</label>
        <input id="cw-own" class="sym-input" maxlength="4" placeholder="\u{1F9ED}" autocomplete="off"></div>
    </div>

    <div class="cw-prev"><span class="eyebrow">Preview</span>
      <div class="chan" aria-current="true" style="pointer-events:none">
        <span class="chan-sym" id="cw-psym">${esc(icon)}</span>
        <span class="chan-name" id="cw-pname">new-channel</span></div></div>

    <p class="gate-error" id="cw-err" hidden></p>
    <button class="btn btn-primary btn-lg" id="cw-go" style="width:100%;justify-content:center">Create channel</button>`, (m, close) => {

    const name = $('#cw-name', m), own = $('#cw-own', m), err = $('#cw-err', m);
    const psym = $('#cw-psym', m), pname = $('#cw-pname', m), go = $('#cw-go', m);
    const slug = (v) => v.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

    const paint = () => { psym.textContent = icon; pname.textContent = slug(name.value) || 'new-channel'; };

    $$('.sym', m).forEach(b => b.onclick = () => {
      icon = b.dataset.sym; own.value = '';
      $$('.sym', m).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      paint();
    });
    own.oninput = () => {
      const picked = [...own.value.trim()].slice(0, 2).join('');
      if (picked) { icon = picked; $$('.sym', m).forEach(x => x.setAttribute('aria-pressed', 'false')); }
      paint();
    };
    name.oninput = paint;
    name.focus();

    go.onclick = async () => {
      const n = slug(name.value);
      if (!n) { err.textContent = 'Give the channel a name.'; err.hidden = false; return; }
      go.disabled = true;
      try {
        const { channel } = await api('POST', `/api/squads/${S.squad.id}/channels`, { name: n, icon });
        S.channel = upsertChannel(channel);
        markChannelRead(channel);
        renderChannels();
        await loadMessages(channel.id);
        setView('chat');
        close();
        toast('Channel created', '#' + channel.name + ' is live for the whole squad.');
      } catch (e) { err.textContent = e.message; err.hidden = false; go.disabled = false; }
    };
  });
}

/* ------------------------------------------------- editor: highlight + hints */
/* A <pre> mirror sits exactly under a transparent textarea. Same font, same
   padding, same line-height — so the painted tokens line up with the real
   caret. The mirror doubles as the ruler for placing the completion popup:
   a zero-width marker at the caret offset gives its pixel position without
   guessing at character widths. */
const KW = {
  cpp: {
    key: 'alignas alignof asm auto break case catch class const consteval constexpr const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern for friend goto if inline mutable namespace new noexcept operator private protected public register reinterpret_cast return sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union using virtual volatile while',
    typ: 'bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t string vector map set unordered_map unordered_set pair queue deque stack priority_queue array bitset tuple istream ostream true false nullptr NULL',
    fn:  'cin cout cerr endl push_back emplace_back pop_back sort reverse max min abs swap begin end rbegin rend size empty find count accumulate lower_bound upper_bound to_string stoi stoll printf scanf memset gcd lcm iota'
  },
  python: {
    key: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
    typ: 'bool bytes complex dict float frozenset int list object set str tuple None True False self cls',
    fn:  'abs all any bin chr dir divmod enumerate eval exec filter format getattr hasattr hash hex id input isinstance iter len map max min next oct open ord pow print range repr reversed round setattr sorted sum type zip append extend insert remove pop join split strip lower upper items keys values get defaultdict Counter deque heappush heappop bisect_left bisect_right'
  }
};
const kwSet = (lang) => {
  const d = KW[lang] || KW.cpp;
  return { key: new Set(d.key.split(/\s+/)), typ: new Set(d.typ.split(/\s+/)), fn: new Set(d.fn.split(/\s+/)) };
};

/* ready-made blocks — the things you retype at the start of every problem */
const SNIPPETS = {
  cpp: [
    { label: 'main', detail: 'int main with fast IO', body: 'int main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    \n    return 0;\n}' },
    { label: 'fori', detail: 'indexed for loop', body: 'for (int i = 0; i < n; i++) {\n    \n}' },
    { label: 'forr', detail: 'range-based for', body: 'for (auto& x : v) {\n    \n}' },
    { label: 'vec', detail: 'vector + read n items', body: 'int n; cin >> n;\nvector<int> v(n);\nfor (auto& x : v) cin >> x;' },
    { label: 'tc', detail: 'multi test-case wrapper', body: 'int t; cin >> t;\nwhile (t--) {\n    solve();\n}' },
    { label: 'dsu', detail: 'disjoint set union', body: 'struct DSU {\n    vector<int> p, r;\n    DSU(int n) : p(n), r(n, 0) { iota(p.begin(), p.end(), 0); }\n    int find(int x) { return p[x] == x ? x : p[x] = find(p[x]); }\n    bool join(int a, int b) {\n        a = find(a); b = find(b);\n        if (a == b) return false;\n        if (r[a] < r[b]) swap(a, b);\n        p[b] = a; if (r[a] == r[b]) r[a]++;\n        return true;\n    }\n};' },
    { label: 'bs', detail: 'binary search on answer', body: 'int lo = 0, hi = 1e9, ans = -1;\nwhile (lo <= hi) {\n    int mid = lo + (hi - lo) / 2;\n    if (ok(mid)) { ans = mid; hi = mid - 1; }\n    else lo = mid + 1;\n}' },
    { label: 'debug', detail: 'print a container', body: 'for (auto& x : v) cerr << x << " ";\ncerr << "\\n";' }
  ],
  python: [
    { label: 'main', detail: 'entry point', body: 'def main():\n    pass\n\nif __name__ == "__main__":\n    main()' },
    { label: 'inp', detail: 'read ints from one line', body: 'n, m = map(int, input().split())' },
    { label: 'arr', detail: 'read a list of ints', body: 'a = list(map(int, input().split()))' },
    { label: 'fast', detail: 'fast stdin reader', body: 'import sys\ninput = sys.stdin.readline' },
    { label: 'tc', detail: 'multi test-case wrapper', body: 'for _ in range(int(input())):\n    solve()' },
    { label: 'dd', detail: 'defaultdict', body: 'from collections import defaultdict\nd = defaultdict(int)' },
    { label: 'heap', detail: 'min-heap', body: 'import heapq\nh = []\nheapq.heappush(h, x)\ntop = heapq.heappop(h)' },
    { label: 'bs', detail: 'bisect', body: 'from bisect import bisect_left, bisect_right\ni = bisect_left(a, x)' }
  ]
};

function highlight(src, lang) {
  const { key, typ, fn } = kwSet(lang);
  const py = lang === 'python';
  /* Five capture groups in a fixed order for both languages, so one handler
     covers each: 1 preprocessor, 2 comment, 3 string, 4 number, 5 word.
     Comments and strings are matched before words, so a keyword inside either
     is consumed there and never re-coloured. Python has no preprocessor, so
     group 1 is given a pattern that cannot occur. */
  const re = py
    ? /(\uFFFF)|(#[^\n]*)|((?:"{3}|'{3})[\s\S]*?(?:"{3}|'{3})|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\w.]*\b)|([A-Za-z_]\w*)/g
    : /(^[ \t]*#[^\n]*)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\w.]*\b)|([A-Za-z_]\w*)/gm;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const t = m[0];
    if (m[1]) out += '<i class="t-p">' + esc(t) + '</i>';
    else if (m[2]) out += '<i class="t-c">' + esc(t) + '</i>';
    else if (m[3]) out += '<i class="t-s">' + esc(t) + '</i>';
    else if (m[4]) out += '<i class="t-n">' + esc(t) + '</i>';
    else {
      const callish = /^\s*\(/.test(src.slice(m.index + t.length));
      const cls = key.has(t) ? 't-k' : typ.has(t) ? 't-t' : fn.has(t) ? 't-f' : callish ? 't-f' : '';
      out += cls ? '<i class="' + cls + '">' + esc(t) + '</i>' : esc(t);
    }
    last = m.index + t.length;
  }
  out += esc(src.slice(last));
  return out;
}

function paintCode() {
  const a = $('#code-area'), hl = $('#code-hl');
  if (!a || !hl) return;
  /* the trailing newline keeps the final line paintable */
  hl.innerHTML = highlight(a.value + '\n', $('#code-lang').value || 'cpp');
  syncCodeScroll();
}
function syncCodeScroll() {
  const a = $('#code-area');
  if (!a) return;
  $('#code-hl').scrollTop = a.scrollTop;
  $('#code-hl').scrollLeft = a.scrollLeft;
  $('#code-gutter').scrollTop = a.scrollTop;
}

/* ---- completions ---- */
const AC = { open: false, items: [], sel: 0, from: 0 };

function wordBefore(a) {
  const upto = a.value.slice(0, a.selectionStart);
  const m = upto.match(/[A-Za-z_]\w*$/);
  return m ? { word: m[0], from: a.selectionStart - m[0].length } : { word: '', from: a.selectionStart };
}

function completionsFor(word, lang) {
  const d = KW[lang] || KW.cpp;
  const seen = new Set();
  const snips = (SNIPPETS[lang] || [])
    .filter(s => s.label.startsWith(word))
    .map(s => { seen.add(s.label); return Object.assign({}, s, { kind: 'snippet' }); });
  const push = (list, kind, detail) => list.split(/\s+/)
    .filter(w => w.length > word.length && w.toLowerCase().startsWith(word.toLowerCase()) && !seen.has(w))
    .map(w => { seen.add(w); return { label: w, body: w, kind, detail }; });
  /* identifiers already in this file, so your own names complete too */
  const own = [...new Set(($('#code-area').value.match(/[A-Za-z_]\w{2,}/g) || []))]
    .filter(w => w.length > word.length && w.startsWith(word) && !seen.has(w))
    .slice(0, 6).map(w => { seen.add(w); return { label: w, body: w, kind: 'local', detail: 'in this file' }; });
  return [].concat(snips, push(d.key, 'keyword', 'keyword'), push(d.typ, 'type', 'type'),
                   push(d.fn, 'fn', 'library'), own).slice(0, 9);
}

/* place the popup by measuring a marker in a hidden copy of the mirror —
   no character-width arithmetic, so proportional glyphs cannot drift it */
function caretXY() {
  const a = $('#code-area'), hl = $('#code-hl');
  const probe = document.createElement('pre');
  probe.className = 'code-hl';
  probe.style.visibility = 'hidden';
  const mark = document.createElement('span');
  mark.textContent = '​';
  probe.append(document.createTextNode(a.value.slice(0, a.selectionStart)), mark);
  hl.parentElement.appendChild(probe);
  const r = mark.getBoundingClientRect();
  const host = $('.code-editor').getBoundingClientRect();
  probe.remove();
  return { x: r.left - host.left - a.scrollLeft, y: r.bottom - host.top - a.scrollTop };
}

function showAC() {
  const a = $('#code-area');
  const { word, from } = wordBefore(a);
  if (word.length < 2) return hideAC();
  const items = completionsFor(word, $('#code-lang').value || 'cpp');
  if (!items.length) return hideAC();

  AC.open = true; AC.items = items; AC.sel = 0; AC.from = from;
  const glyph = { snippet: '◆', keyword: 'K', type: 'T', fn: 'f', local: '·' };
  const box = $('#code-ac');
  box.innerHTML = items.map((it, i) =>
    '<button class="ac-i" role="option" data-i="' + i + '" aria-selected="' + (i === 0) + '">' +
    '<span class="ac-k ac-' + it.kind + '">' + glyph[it.kind] + '</span>' +
    '<span class="ac-l">' + esc(it.label) + '</span>' +
    '<span class="ac-d">' + esc(it.detail || '') + '</span></button>').join('');
  box.hidden = false;

  const host = $('.code-editor');
  const { x, y } = caretXY();
  box.style.left = Math.max(4, Math.min(x, host.clientWidth - box.offsetWidth - 8)) + 'px';
  const below = y + 6;
  box.style.top = (below + box.offsetHeight > host.clientHeight
    ? Math.max(4, y - box.offsetHeight - 22) : below) + 'px';
}
function hideAC() { AC.open = false; const b = $('#code-ac'); if (b) b.hidden = true; }

function applyAC(i) {
  const a = $('#code-area'), it = AC.items[i];
  if (!it) return;
  const before = a.value.slice(0, AC.from), after = a.value.slice(a.selectionStart);
  /* a snippet keeps the indentation of the line that triggered it */
  const indent = (before.match(/(^|\n)([ \t]*)[^\n]*$/) || [null, null, ''])[2] || '';
  const body = it.kind === 'snippet' ? it.body.split('\n').join('\n' + indent) : it.body;
  a.value = before + body + after;
  a.selectionStart = a.selectionEnd = before.length + body.length;
  hideAC();
  paintCode(); paintGutter(); touchSnippet();
  a.focus();
}

const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };

function editorKeys(e) {
  const a = e.target;
  if (AC.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      AC.sel = (AC.sel + (e.key === 'ArrowDown' ? 1 : AC.items.length - 1)) % AC.items.length;
      $$('.ac-i').forEach((b, i) => b.setAttribute('aria-selected', String(i === AC.sel)));
      $$('.ac-i')[AC.sel]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return applyAC(AC.sel); }
    if (e.key === 'Escape') { e.preventDefault(); return hideAC(); }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ' ') { e.preventDefault(); return showAC(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); return runSnippet(); }

  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const st = a.selectionStart, en = a.selectionEnd;
    a.value = a.value.slice(0, st) + '    ' + a.value.slice(en);
    a.selectionStart = a.selectionEnd = st + 4;
    return afterEdit();
  }

  /* type an opening bracket and get its partner, wrapping any selection */
  if (PAIRS[e.key]) {
    const st = a.selectionStart, en = a.selectionEnd;
    if (st !== en) {
      e.preventDefault();
      const sel = a.value.slice(st, en);
      a.value = a.value.slice(0, st) + e.key + sel + PAIRS[e.key] + a.value.slice(en);
      a.selectionStart = st + 1; a.selectionEnd = en + 1;
      return afterEdit();
    }
    if (!/[\w$]/.test(a.value[st] || '')) {
      e.preventDefault();
      a.value = a.value.slice(0, st) + e.key + PAIRS[e.key] + a.value.slice(st);
      a.selectionStart = a.selectionEnd = st + 1;
      return afterEdit();
    }
  }
  /* typing a closer that is already there steps over it instead of doubling */
  if ([')', ']', '}', '"', "'"].includes(e.key)
      && a.selectionStart === a.selectionEnd && a.value[a.selectionStart] === e.key) {
    e.preventDefault();
    a.selectionStart = a.selectionEnd = a.selectionStart + 1;
    return;
  }
  if (e.key === 'Backspace' && a.selectionStart === a.selectionEnd) {
    const prev = a.value[a.selectionStart - 1], next = a.value[a.selectionStart];
    if (PAIRS[prev] && PAIRS[prev] === next) {
      e.preventDefault();
      const st = a.selectionStart;
      a.value = a.value.slice(0, st - 1) + a.value.slice(st + 1);
      a.selectionStart = a.selectionEnd = st - 1;
      return afterEdit();
    }
  }
  if (e.key === 'Enter') {
    const st = a.selectionStart;
    const line = a.value.slice(0, st).split('\n').pop();
    const indent = (line.match(/^[ \t]*/) || [''])[0];
    const opens = /[{([:]\s*$/.test(line);
    if (indent || opens) {
      e.preventDefault();
      const pad = indent + (opens ? '    ' : '');
      let insert = '\n' + pad;
      const caret = st + insert.length;
      /* a brace pair gets its closing line placed for you */
      if (opens && /^[ \t]*[}\])]/.test(a.value.slice(st))) insert += '\n' + indent;
      a.value = a.value.slice(0, st) + insert + a.value.slice(st);
      a.selectionStart = a.selectionEnd = caret;
      return afterEdit();
    }
  }
}

function afterEdit() { paintCode(); paintGutter(); touchSnippet(); hideAC(); }

/* -------------------------------------------------------- voice messages */
/* Recording needs a secure context, so it works on localhost and over the
   tunnel but not over plain http on a LAN address — the failure says so
   rather than silently doing nothing. */
const V = { rec: null, chunks: [], stream: null, ctx: null, raf: null, t0: 0, tick: null, peaks: [], cancelled: false, busy: false };
const VOICE_MAX_MS = 90000;
const WAVE_BARS = 40;

const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  .find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';

function buildWave() {
  $('#rec-wave').innerHTML = Array.from({ length: WAVE_BARS }, () => '<i></i>').join('');
}

async function startRecording() {
  if (V.rec || V.busy) return;
  if (!window.isSecureContext) {
    return toast('Microphone needs a secure page',
      'Open Squadron on localhost or over the https link — plain http cannot reach the mic.');
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return toast('Voice notes are not supported here', 'This browser has no MediaRecorder.');
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (err) { const [t, sub] = await mediaReason(err); return toast(t, sub); }

  V.stream = stream; V.chunks = []; V.peaks = []; V.cancelled = false;
  const mime = pickMime();
  try { V.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch { V.rec = new MediaRecorder(stream); }

  V.rec.ondataavailable = (e) => { if (e.data?.size) V.chunks.push(e.data); };
  V.rec.onstop = () => finishRecording();
  V.rec.start();

  V.t0 = Date.now();
  $('#rec').hidden = false;
  $('#composer').disabled = true;
  $('#voice-btn').setAttribute('aria-pressed', 'true');
  buildWave();

  /* the bars follow the real signal, so the animation is the microphone
     rather than a decorative loop */
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    V.ctx = new AC();
    const src = V.ctx.createMediaStreamSource(stream);
    const an = V.ctx.createAnalyser();
    an.fftSize = 512; an.smoothingTimeConstant = 0.72;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const bars = $$('#rec-wave i');
    let since = 0;
    const draw = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      const level = Math.min(100, Math.round((peak / 128) * 165));   /* speech rarely clips */
      /* push the newest level in on the right, everything shuffles left */
      bars.forEach((b, i) => {
        const next = i === bars.length - 1 ? level : Number(bars[i + 1].dataset.v || 0);
        b.dataset.v = next;
        b.style.transform = `scaleY(${Math.max(0.06, next / 100)})`;
      });
      if (Date.now() - since > 140) { V.peaks.push(level); since = Date.now(); }
      V.raf = requestAnimationFrame(draw);
    };
    draw();
  }

  V.tick = setInterval(() => {
    const ms = Date.now() - V.t0;
    $('#rec-time').textContent = fmtClip(ms);
    if (ms >= VOICE_MAX_MS) { toast('That is the limit', 'Voice notes stop at 90 seconds.'); stopRecording(); }
  }, 200);
}

const fmtClip = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function stopRecording() { if (V.rec && V.rec.state !== 'inactive') V.rec.stop(); }
function cancelRecording() { V.cancelled = true; stopRecording(); }

function teardownRecorder() {
  clearInterval(V.tick); cancelAnimationFrame(V.raf);
  V.stream?.getTracks().forEach(t => t.stop());
  V.ctx?.close?.().catch(() => {});
  V.rec = null; V.stream = null; V.ctx = null; V.tick = null; V.raf = null;
  $('#rec').hidden = true;
  $('#rec-time').textContent = '0:00';
  $('#composer').disabled = false;
  $('#voice-btn').setAttribute('aria-pressed', 'false');
}

async function finishRecording() {
  const ms = Date.now() - V.t0;
  const chunks = V.chunks, type = V.rec?.mimeType || 'audio/webm';
  const cancelled = V.cancelled;
  /* sample the collected levels down to a fixed number of bars for the player */
  const src = V.peaks.length ? V.peaks : [];
  const peaks = Array.from({ length: 28 }, (_, i) =>
    src.length ? src[Math.floor(i * src.length / 28)] : 0);
  teardownRecorder();

  if (cancelled) return;
  if (ms < 500) return toast('Too short', 'Hold the microphone a little longer.');
  if (!chunks.length || !S.channel) return;

  V.busy = true;
  try {
    const blob = new Blob(chunks, { type });
    const audio = await blobToBase64(blob);
    const { message } = await api('POST', `/api/channels/${S.channel.id}/voice`,
      { audio, mime: type.split(';')[0], ms, peaks });
    upsertMessage(message);
  } catch (e) { toast('Voice note not sent', e.message); }
  finally { V.busy = false; }
}

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = rej;
  r.readAsDataURL(blob);
});

$('#voice-btn').onclick = () => (V.rec ? stopRecording() : startRecording());
$('#rec-stop').onclick = stopRecording;
$('#rec-cancel').onclick = cancelRecording;

/* ---- playback ---- */
let nowPlaying = null;
function voiceHtml(m) {
  const v = m.voice;
  if (!v) return '<p><i>voice note unavailable</i></p>';
  const bars = (v.peaks.length ? v.peaks : Array(28).fill(18))
    .map(p => `<i style="transform:scaleY(${Math.max(0.08, p / 100)})"></i>`).join('');
  return `<div class="vn" data-vn="${v.id}">
    <button class="vn-play" data-vn-play aria-label="Play voice message">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-play"/></svg></button>
    <span class="vn-wave">${bars}<span class="vn-prog"></span></span>
    <span class="vn-t mono">${fmtClip(v.ms)}</span></div>`;
}

$('#msgs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-vn-play]');
  if (!btn) return;
  const box = btn.closest('.vn');
  const id = box.dataset.vn;
  if (nowPlaying && nowPlaying.id !== id) stopVoice();
  if (nowPlaying && nowPlaying.id === id) { stopVoice(); return; }

  const audio = new Audio(`/api/voice/${id}`);
  nowPlaying = { id, audio, box };
  box.dataset.playing = '1';
  $('use', btn).setAttribute('href', '#i-pause');
  const prog = $('.vn-prog', box);
  audio.ontimeupdate = () => {
    if (audio.duration && isFinite(audio.duration))
      prog.style.width = Math.min(100, (audio.currentTime / audio.duration) * 100) + '%';
  };
  audio.onended = stopVoice;
  audio.onerror = () => { toast('Could not play that clip', 'The audio may no longer be there.'); stopVoice(); };
  audio.play().catch((err) => { toast('Could not play that clip', err.message); stopVoice(); });
});

function stopVoice() {
  if (!nowPlaying) return;
  const { audio, box } = nowPlaying;
  audio.pause();
  box.removeAttribute('data-playing');
  const use = $('.vn-play use', box);
  use?.setAttribute('href', '#i-play');
  $('.vn-prog', box).style.width = '0%';
  nowPlaying = null;
}

/* ------------------------------------------------------------- compiler */
/* Two shelves of files. `personal` is fetched for you alone and never leaves
   your account; `team` is the squad's shared scratchpad and syncs live. The
   panel takes 40% of the workspace so the channel stays readable beside it. */
const C = { open: false, scope: 'personal', shownFor: null, personal: [], team: [], cur: null, runner: null, langs: [], dirty: false, timer: null, busy: false };

const snipList = () => (C.scope === 'team' ? C.team : C.personal);
const canDelete = (sn) => sn && (sn.author.id === S.me?.id || S.squad?.role === 'captain');

async function openCode() {
  if (!S.squad) return;
  /* both want the content area; a docked thread beside a full-width compiler
     is what pushed one of them under the sidebar */
  if (TH.root) closeThread();
  C.open = true;
  $('#code').hidden = false;
  $('#app').dataset.code = '1';
  await loadSnippets();
}
function closeCode() {
  if (C.running) { liveStop(); }
  flushSnippet();
  C.open = false;
  $('#code').hidden = true;
  delete $('#app').dataset.code;
}

async function loadSnippets() {
  try {
    const d = await api('GET', `/api/squads/${S.squad.id}/snippets`);
    C.personal = d.personal; C.team = d.team; C.runner = d.runner; C.langs = d.langs;
    $('#code-lang').innerHTML = C.langs.map(l => `<option value="${l.key}">${esc(l.label)}</option>`).join('');
    const keep = C.cur && snipList().find(x => x.id === C.cur.id);
    C.cur = keep || snipList()[0] || null;
    renderSnippets();
  } catch (e) { toast('Compiler unavailable', e.message); }
}

function renderSnippets() {
  $$('.code-scope').forEach(b => b.setAttribute('aria-selected', String(b.dataset.scope === C.scope)));
  const list = snipList();
  $('#code-files').innerHTML =
    list.map(sn => `<button class="code-file${C.cur && sn.id === C.cur.id ? ' on' : ''}" data-snip="${sn.id}">
      <span class="code-file-n">${esc(sn.title)}</span>
      <span class="code-file-l mono">${esc(sn.lang === 'cpp' ? 'C++' : 'Py')}</span>
      ${C.scope === 'team' ? `<span class="code-file-a">${esc(sn.author.name.split(' ')[0])}</span>` : ''}
    </button>`).join('') +
    `<button class="code-file code-file-new" data-new-snip>+ New ${C.scope === 'team' ? 'team' : 'personal'} file</button>`;

  const has = !!C.cur;
  $('#code-body').hidden = !has;
  $('#code-empty').hidden = has;
  if (!has) return;

  /* output belongs to the file that produced it — never carry it across */
  if (C.shownFor !== C.cur.id) {
    C.shownFor = C.cur.id;
    $('#code-out').textContent = '';
    $('#code-out').removeAttribute('data-state');
    $('#code-meta').textContent = '';
  }

  $('#code-title').value = C.cur.title;
  $('#code-lang').value = C.cur.lang;
  $('#code-area').value = C.cur.body;
  $('#code-del').hidden = !canDelete(C.cur);
  paintGutter(); paintCode(); hideAC();
  $('#code-lib').hidden = C.cur.scope !== 'team';
  loadCases();
  markSaved(C.cur.updatedBy && C.cur.updatedBy.id !== S.me?.id
    ? `saved by ${C.cur.updatedBy.name.split(' ')[0]}` : 'saved');
  if (C.runner && !C.runner.ok) {
    $('#code-go').disabled = true;
    $('#code-go').title = C.runner.reason;
  } else { $('#code-go').disabled = false; $('#code-go').title = ''; }
}

function paintGutter() {
  const n = $('#code-area').value.split('\n').length;
  $('#code-gutter').innerHTML = Array.from({ length: n }, (_, i) => `<span>${i + 1}</span>`).join('');
  $('#code-gutter').scrollTop = $('#code-area').scrollTop;
}
function markSaved(text) { $('#code-saved').textContent = text; }

/* typing saves on a debounce; switching away flushes immediately so nothing
   is lost between the last keystroke and the tab change */
function touchSnippet() {
  if (!C.cur) return;
  C.dirty = true;
  markSaved('saving…');
  clearTimeout(C.timer);
  C.timer = setTimeout(flushSnippet, 700);
}
async function flushSnippet() {
  clearTimeout(C.timer);
  if (!C.dirty || !C.cur) return;
  const id = C.cur.id;
  const payload = {
    title: $('#code-title').value, lang: $('#code-lang').value,
    body: $('#code-area').value
  };
  C.dirty = false;
  try {
    const { snippet } = await api('PATCH', `/api/snippets/${id}`, payload);
    upsertSnippet(snippet, true);
    markSaved('saved');
  } catch (e) { C.dirty = true; markSaved('not saved'); toast('Could not save', e.message); }
}

function upsertSnippet(sn, quiet) {
  const list = sn.scope === 'team' ? C.team : C.personal;
  const i = list.findIndex(x => x.id === sn.id);
  if (i > -1) list[i] = sn; else list.unshift(sn);
  if (C.cur && C.cur.id === sn.id) {
    C.cur = sn;
    /* a live edit from a teammate must not yank the caret out from under you */
    if (!quiet && document.activeElement !== $('#code-area')) renderSnippets();
    else if (quiet) {
      $('#code-del').hidden = !canDelete(sn);
      /* Redrawing the whole list here would move the caret, but the tab still has
         to keep up: switching a file to Python left its chip reading C++ for the
         rest of the session — a confusing thing to stare at while a Python
         traceback prints underneath it. */
      const chip = $(`[data-snip="${sn.id}"] .code-file-l`);
      if (chip) chip.textContent = sn.lang === 'cpp' ? 'C++' : 'Py';
    }
  } else if (C.open) renderSnippets();
}

async function newSnippet() {
  const lang = C.langs[0]?.key || 'cpp';
  const starter = lang === 'cpp'
    ? '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n'
    : 'def main():\n    pass\n\nmain()\n';
  try {
    const { snippet } = await api('POST', `/api/squads/${S.squad.id}/snippets`,
      { scope: C.scope, title: 'untitled', lang, body: starter });
    upsertSnippet(snippet);
    C.cur = snippet;
    renderSnippets();
    $('#code-title').select();
  } catch (e) { toast('Could not create the file', e.message); }
}

async function runSnippet() {
  if (C.running) { liveStop(); liveAppend('\n— stopped\n'); $('#code-meta').textContent = 'stopped'; return; }
  /* C.running guards the interactive path, C.busy the batch one — and the live
     branch must be taken before C.busy is set, because only the batch path has
     the finally that clears it. Setting it first left C.busy stuck true after
     the first interactive run, and every later Run returned here in silence. */
  if (C.busy || C.running || !C.cur) return;
  await flushSnippet();
  /* Always run live. The separate input box is gone: a program that wants
     something now asks for it in the output, and you answer there — including
     by pasting a whole case at once, which is what the box was for. The request
     path below survives only as a fallback for a dropped socket. */
  if (S.ws?.readyState === 1) return runLive();
  C.busy = true;
  const go = $('#code-go');
  go.disabled = true; go.dataset.busy = '1';
  $('#code-out').textContent = 'Running…';
  $('#code-out').dataset.state = 'wait';
  $('#code-meta').textContent = '';
  try {
    const r = await api('POST', '/api/run', {
      squadId: S.squad.id, lang: $('#code-lang').value,
      source: $('#code-area').value, stdin: ''
    });
    const parts = [];
    if (r.stdout) parts.push(r.stdout.replace(/\n$/, ''));
    if (r.stderr) parts.push(r.stderr.replace(/\n$/, ''));


    $('#code-out').textContent = parts.join('\n') || '(no output)';
    $('#code-out').dataset.state = r.ok ? 'ok' : 'bad';
    /* "exit ?" was what a crash or a runaway loop used to report — a null exit
       code means the kernel killed it, and the signal is the actual answer. */
    const label = { compile: 'did not compile', timeout: 'timed out', blocked: 'blocked', error: 'failed' }[r.stage]
      || (r.ok ? 'exit 0'
        : r.signal ? 'killed · ' + r.signal
        : typeof r.exitCode === 'number' ? 'exit ' + r.exitCode
        : 'stopped');
    $('#code-meta').textContent = `${label} · ${r.ms} ms`;
  } catch (e) {
    $('#code-out').textContent = e.message;
    $('#code-out').dataset.state = 'bad';
  } finally { C.busy = false; go.disabled = false; delete go.dataset.busy; }
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', what, 'ok');
  } catch {
    /* clipboard needs a secure context — fall back to a selectable prompt */
    const ta = el('textarea', 'copy-fallback'); ta.value = text;
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied', what, 'ok'); }
    catch { toast('Could not copy', 'Select the text and copy it by hand.'); }
    ta.remove();
  }
}

function shareSnippet() {
  if (!C.cur) return;
  const mates = (S.squad?.members || []).filter(m => m.id !== S.me?.id);
  modal('Share this file', `
    <div class="fld"><label for="sh-chan">Post it in</label>
      <select id="sh-chan">${S.squad.channels.map(c => `<option value="${c.id}">${esc(c.icon || '#')} ${esc(c.name)}</option>`).join('')}</select></div>
    <div class="fld"><label for="sh-who">Point it at someone <span class="wz-opt">optional</span></label>
      <select id="sh-who"><option value="">the whole squad</option>
        ${mates.map(m => `<option value="${m.id}">${esc(m.name)} · ${esc(m.handle)}</option>`).join('')}</select></div>
    <div class="fld"><label for="sh-note">Say something</label>
      <input id="sh-note" type="text" maxlength="300" value="Sharing ${esc(C.cur.title)}"></div>
    <p class="fld-help">The code is posted into the channel, so everyone in the squad can read it there.</p>
    <p class="gate-error" id="sh-err" hidden></p>
    <button class="btn btn-primary btn-lg" id="sh-go" style="width:100%;justify-content:center">Post it</button>`,
  (m, close) => {
    $('#sh-go', m).onclick = async () => {
      $('#sh-go', m).disabled = true;
      try {
        await flushSnippet();
        const r = await api('POST', `/api/snippets/${C.cur.id}/share`, {
          channelId: $('#sh-chan', m).value, to: $('#sh-who', m).value || null, note: $('#sh-note', m).value
        });
        close();
        toast('Shared', `Posted in #${r.channel.name}`, 'ok');
      } catch (e) { $('#sh-err', m).textContent = e.message; $('#sh-err', m).hidden = false; $('#sh-go', m).disabled = false; }
    };
  });
}

async function deleteSnippet() {
  if (!C.cur || !canDelete(C.cur)) return;
  const sn = C.cur;
  if (!confirm(`Delete "${sn.title}"? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/snippets/${sn.id}`);
    dropSnippet(sn.id);
    toast('Deleted', sn.title, 'ok');
  } catch (e) { toast('Could not delete', e.message); }
}
function dropSnippet(id) {
  C.personal = C.personal.filter(x => x.id !== id);
  C.team = C.team.filter(x => x.id !== id);
  if (C.cur && C.cur.id === id) C.cur = snipList()[0] || null;
  if (C.open) renderSnippets();
}

/* ---- wiring ---- */
/* ---- the editor / output split ----
   The output pane used to be a fixed 38% of the compiler. That is the wrong
   number for almost everyone: reading a stack trace wants it tall, writing a
   solution wants it out of the way. The size is the user's to set, held as a
   percentage so it survives a window resize, and remembered. */
const SPLIT_MIN = 12, SPLIT_MAX = 70, SPLIT_DEFAULT = 38;

function setSplit(pct, remember = true) {
  const v = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct));
  $('#code-body').style.setProperty('--out-h', v.toFixed(1) + '%');
  $('#code-split').setAttribute('aria-valuenow', Math.round(v));
  if (remember) { try { localStorage.setItem('sq.split', String(v)); } catch {} }
  return v;
}

(() => {
  const bar = $('#code-split'), body = $('#code-body');
  let start = 0, startPct = SPLIT_DEFAULT;

  let saved = SPLIT_DEFAULT;
  try { saved = Number(localStorage.getItem('sq.split')) || SPLIT_DEFAULT; } catch {}
  setSplit(saved, false);

  const pctNow = () => ($('#code-out').getBoundingClientRect().height / body.getBoundingClientRect().height) * 100;

  const move = (e) => {
    /* dragging up grows the output, which is the direction the handle moves */
    const dy = e.clientY - start;
    setSplit(startPct - (dy / body.getBoundingClientRect().height) * 100);
  };
  /* Detaching comes first and pointer capture is guarded, because
     releasePointerCapture throws when the pointer is not actually captured.
     Letting that escape left the move listener attached, so the splitter went
     on following the cursor after the mouse button was already up — and the
     next drag then fought with a stale one. */
  const stop = (e) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', stop);
    removeEventListener('pointercancel', stop);
    bar.removeAttribute('data-drag');
    document.body.style.userSelect = '';
    try { bar.releasePointerCapture(e.pointerId); } catch {}
  };

  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stop(e);                       // never run two drags at once
    start = e.clientY;
    startPct = pctNow();
    bar.dataset.drag = '1';
    /* without this a drag selects the code behind it */
    document.body.style.userSelect = 'none';
    addEventListener('pointermove', move);
    addEventListener('pointerup', stop);
    addEventListener('pointercancel', stop);
    try { bar.setPointerCapture(e.pointerId); } catch {}
  });

  /* a separator that only answers a mouse is not operable at all for some people */
  bar.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 3;
    const cur = pctNow();
    if (e.key === 'ArrowUp')        setSplit(cur + step);
    else if (e.key === 'ArrowDown') setSplit(cur - step);
    else if (e.key === 'Home')      setSplit(SPLIT_MAX);
    else if (e.key === 'End')       setSplit(SPLIT_MIN);
    else if (e.key === 'Enter')     setSplit(SPLIT_DEFAULT);
    else return;
    e.preventDefault();
  });

  bar.addEventListener('dblclick', () => { setSplit(SPLIT_DEFAULT); toast('Split reset', 'Back to the default height', 'ok'); });
})();

/* ---- interactive runs ----
   The batch path posts the whole of stdin and waits. This one keeps the program
   alive over the socket: output arrives as it is printed, and a typed line goes
   back the way it would at a terminal. Which is what anyone who has used an IDE
   expects when a program stops and asks them something. */
const liveRow = () => $('#code-live-row');

/* `kind` is 'in' for a line the person typed. It matters more than it looks:
   stdin is a pipe, so nothing echoes it, and the copy we paint here used to be
   indistinguishable from what the program printed. Feed `input()` a 12 and the
   console read `12` twice — once because you typed it, once because the program
   printed it — which reads as a bug rather than as a terminal. Typed lines are
   now marked, so the two are never mistaken for each other. */
function liveAppend(text, kind) {
  const out = $('#code-out');
  if (kind === 'in') {
    const s = document.createElement('span');
    s.className = 'co-in';
    s.textContent = text;
    out.appendChild(s);
  } else {
    out.appendChild(document.createTextNode(text));
  }
  out.scrollTop = out.scrollHeight;
}
/* The stop control lives on the Run button as well as beside the input line.
   One of the two is always where the eye already is. */
function paintRunButton() {
  const b = $('#code-go');
  $('#code-go-t').textContent = C.running ? 'Stop' : 'Run';
  $('#code-go-ic').innerHTML = `<use href="#${C.running ? 'i-x' : 'i-play'}"/>`;
  b.classList.toggle('btn-primary', !C.running);
  b.classList.toggle('is-stop', !!C.running);
  b.setAttribute('aria-label', C.running ? 'Stop the running program' : 'Run');
}
function liveStop(quiet) {
  if (!C.running) return;
  C.running = false;
  C.busy = false;
  liveRow().hidden = true;
  restoreConsole();
  $('#code-go').disabled = false;
  delete $('#code-go').dataset.busy;
  paintRunButton();
  if (!quiet) safeSend({ type: 'code-kill' });
}
$('#code-live-stop').onclick = () => { liveStop(); liveAppend('\n— stopped\n'); $('#code-meta').textContent = 'stopped'; };
function sendLine(line) {
  /* a pipe does not echo, so the line is shown here or it vanishes */
  liveAppend(line, 'in');
  liveAppend('\n');
  safeSend({ type: 'code-stdin', line });
}
$('#code-live-in').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const line = e.target.value;
  e.target.value = '';
  sendLine(line);
});
/* Pasting a whole test case has to work, or removing the old input box would
   have taken something away: competitive problems arrive as a block of lines,
   not as one answer at a time. Each line is fed in order, as a terminal would. */
$('#code-live-in').addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text') ?? '';
  if (!/\n/.test(text)) return;                 // a single value pastes normally
  e.preventDefault();
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const box = e.target;
  const head = box.value;
  box.value = '';
  lines.forEach((l, i) => sendLine(i === 0 ? head + l : l));
});

/* While a program is asking questions the console is the part you are using, so
   it takes the room — then gives it back, unless you moved the splitter yourself
   in the meantime. */
function growConsole() {
  const body = $('#code-body');
  const cur = parseFloat(getComputedStyle(body).getPropertyValue('--out-h')) ||
    ($('#code-out').getBoundingClientRect().height / body.getBoundingClientRect().height * 100);
  if (cur >= 55) return;
  C.splitBefore = cur;
  C.splitSet = setSplit(58, false);
}
function restoreConsole() {
  if (C.splitBefore == null) return;
  const now = parseFloat(getComputedStyle($('#code-body')).getPropertyValue('--out-h'));
  if (C.splitSet != null && Math.abs(now - C.splitSet) < 0.6) setSplit(C.splitBefore, false);
  C.splitBefore = C.splitSet = null;
}

async function runLive() {
  if (!S.squad) return toast('Join a squad first', 'Running code is scoped to a squad.');
  C.running = true;
  paintRunButton();
  $('#code-out').textContent = '';
  $('#code-out').dataset.state = 'wait';
  $('#code-meta').textContent = 'running…';
  liveRow().hidden = false;
  growConsole();
  setTimeout(() => $('#code-live-in').focus(), 80);
  if (!(await waitForSocket(5000))) {
    liveStop(true);
    $('#code-out').textContent = 'Lost the connection to the server. Reload and try again.';
    $('#code-out').dataset.state = 'bad';
    return;
  }
  safeSend({ type: 'code-run', lang: $('#code-lang').value, source: $('#code-area').value });
}

/* called from the socket handler */
function onCodeOut(msg) { if (C.running) liveAppend(msg.chunk || ''); }
function onCodeEnd(msg) {
  liveStop(true);
  const label = msg.stage === 'compile' ? 'did not compile'
    : msg.stage === 'blocked' ? 'blocked'
    : msg.stage === 'error' ? 'failed'
    : msg.timedOut ? 'stopped after 3 minutes'
    : msg.signal ? 'killed · ' + msg.signal
    : typeof msg.exitCode === 'number' ? 'exit ' + msg.exitCode : 'finished';
  if (msg.stderr) liveAppend((($('#code-out').textContent && !$('#code-out').textContent.endsWith('\n')) ? '\n' : '') + msg.stderr);
  if (!$('#code-out').textContent.trim()) $('#code-out').textContent = '(no output)';
  $('#code-out').dataset.state = (msg.exitCode === 0 && !msg.timedOut) ? 'ok' : 'bad';
  $('#code-meta').textContent = msg.ms ? `${label} · ${msg.ms} ms` : label;
}

$('#code-close').onclick = closeCode;
$('#code-files').addEventListener('click', async (e) => {
  if (e.target.closest('[data-new-snip]')) return newSnippet();
  const b = e.target.closest('[data-snip]');
  if (!b) return;
  await flushSnippet();
  C.cur = snipList().find(x => x.id === b.dataset.snip) || null;
  renderSnippets();
});
$('#code-empty').addEventListener('click', (e) => { if (e.target.closest('[data-new-snip]')) newSnippet(); });
$$('.code-scope').forEach(b => b.onclick = async () => {
  await flushSnippet();
  C.scope = b.dataset.scope;
  C.cur = snipList()[0] || null;
  renderSnippets();
});
$('#code-title').addEventListener('input', touchSnippet);
$('#code-lang').addEventListener('change', () => { paintCode(); touchSnippet(); });
$('#code-area').addEventListener('input', () => { paintCode(); paintGutter(); touchSnippet(); showAC(); });
$('#code-area').addEventListener('scroll', syncCodeScroll);
$('#code-area').addEventListener('blur', () => setTimeout(hideAC, 120));
$('#code-area').addEventListener('click', hideAC);
/* Tab indents, brackets close themselves, Enter keeps your indentation */
$('#code-area').addEventListener('keydown', editorKeys);
$('#code-ac').addEventListener('mousedown', (e) => {
  const b = e.target.closest('.ac-i');
  if (b) { e.preventDefault(); applyAC(Number(b.dataset.i)); }
});
$('#code-go').onclick = runSnippet;
$('#code-copy').onclick = () => copyText($('#code-area').value, C.cur ? C.cur.title : 'code');
$('#code-copyout').onclick = () => copyText($('#code-out').textContent, 'program output');
$('#code-share').onclick = shareSnippet;
$('#code-del').onclick = deleteSnippet;

/* --------------------------------------------------------- focus timer */
/* A pomodoro that survives a reload: what is stored is the wall-clock instant
   the phase ends, not a countdown, so closing the tab and coming back does not
   hand you back time you already spent. */
const POM_KEY = 'sq.pom';
const P = { focus: 25, brk: 5, phase: 'focus', endsAt: 0, left: 25 * 60e3, running: false, done: 0, day: '', tick: null };

function pomLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(POM_KEY) || '{}');
    Object.assign(P, {
      focus: raw.focus || 25, brk: raw.brk || 5,
      phase: raw.phase === 'break' ? 'break' : 'focus',
      endsAt: raw.endsAt || 0, left: raw.left ?? (raw.focus || 25) * 60e3,
      running: !!raw.running, done: raw.done || 0, day: raw.day || todayKey()
    });
    if (P.day !== todayKey()) { P.done = 0; P.day = todayKey(); }
  } catch {}
  if (P.running && P.endsAt <= Date.now()) { P.running = false; P.left = 0; }
}
function pomSave() {
  try {
    localStorage.setItem(POM_KEY, JSON.stringify({
      focus: P.focus, brk: P.brk, phase: P.phase, endsAt: P.endsAt,
      left: P.left, running: P.running, done: P.done, day: P.day
    }));
  } catch {}
}
const todayKey = () => new Date().toISOString().slice(0, 10);
const phaseMs = () => (P.phase === 'focus' ? P.focus : P.brk) * 60e3;
const pomLeft = () => (P.running ? Math.max(0, P.endsAt - Date.now()) : P.left);

function pomFmt(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function pomPaint() {
  const left = pomLeft(), total = phaseMs() || 1;
  const pct = Math.max(0, Math.min(1, 1 - left / total));
  const C = 2 * Math.PI * 15.5;
  const arc = $('#pom-arc');
  if (arc) { arc.style.strokeDasharray = C; arc.style.strokeDashoffset = C * (1 - pct); }
  $('#pom-time').textContent = pomFmt(left);
  $('#pom-label').textContent = P.running
    ? (P.phase === 'focus' ? 'Focusing' : 'On a break')
    : (left < phaseMs() ? (P.phase === 'focus' ? 'Focus paused' : 'Break paused') : 'Focus timer');
  $('#pom-ico').textContent = P.phase === 'focus' ? '⏱' : '☕';
  $('#pom').dataset.phase = P.phase;
  $('#pom').dataset.state = P.running ? 'run' : (left < phaseMs() ? 'paused' : 'idle');
  $('#pom-go').textContent = P.running ? 'Pause' : (left < phaseMs() ? 'Resume' : 'Start');
  $('#pom-done').textContent = `${P.done} session${P.done === 1 ? '' : 's'} today`;
  /* the tab title is the only place a countdown is visible from another app */
  document.title = P.running ? `${pomFmt(left)} · ${P.phase === 'focus' ? 'Focus' : 'Break'} — Squadron` : 'Squadron';
}

function pomLoop() {
  clearInterval(P.tick);
  if (!P.running) return;
  P.tick = setInterval(() => {
    if (pomLeft() > 0) return pomPaint();
    pomComplete();
  }, 250);
}

function pomComplete() {
  clearInterval(P.tick);
  const wasFocus = P.phase === 'focus';
  if (wasFocus) { P.done += 1; P.day = todayKey(); }
  P.phase = wasFocus ? 'break' : 'focus';
  P.running = false;
  P.left = phaseMs();
  P.endsAt = 0;
  pomSave(); pomPaint();
  pomChime();
  toast(wasFocus ? 'Focus block done' : 'Break over',
    wasFocus ? `Take ${P.brk} minutes. That is ${P.done} today.` : `Back to it — ${P.focus} minutes.`, 'ok');
  $('#pom').dataset.ring = '1';
  setTimeout(() => $('#pom').removeAttribute('data-ring'), 2600);
}

/* a short two-note chime, synthesised so there is no audio file to ship */
function pomChime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g2 = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g2); g2.connect(ctx.destination);
      const t0 = ctx.currentTime + i * 0.17;
      g2.gain.setValueAtTime(0.0001, t0);
      g2.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
      g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.start(t0); o.stop(t0 + 0.52);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1400);
  } catch {}
}

function pomStart() {
  if (P.running) {                       /* pause */
    P.left = pomLeft(); P.running = false; P.endsAt = 0;
  } else {
    if (P.left <= 0) P.left = phaseMs();
    P.endsAt = Date.now() + P.left; P.running = true;
  }
  pomSave(); pomPaint(); pomLoop();
}
function pomReset() {
  P.running = false; P.endsAt = 0; P.left = phaseMs();
  clearInterval(P.tick); pomSave(); pomPaint();
}
function pomSkip() {
  P.phase = P.phase === 'focus' ? 'break' : 'focus';
  pomReset();
}

$('#pom-toggle').onclick = () => {
  const b = $('#pom-body');
  b.hidden = !b.hidden;
  $('#pom-toggle').setAttribute('aria-expanded', String(!b.hidden));
};
$('#pom-go').onclick = pomStart;
$('#pom-reset').onclick = pomReset;
$('#pom-skip').onclick = pomSkip;
$$('.pom-len').forEach(b => b.onclick = () => {
  P.focus = Number(b.dataset.focus); P.brk = Number(b.dataset.break);
  $$('.pom-len').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  pomReset();
});
/* a timer that kept running in a background tab must show the truth on return */
addEventListener('visibilitychange', () => { if (!document.hidden) { if (P.running && pomLeft() <= 0) pomComplete(); else pomPaint(); } });

pomLoad();
$$('.pom-len').forEach(b => b.setAttribute('aria-pressed',
  String(Number(b.dataset.focus) === P.focus && Number(b.dataset.break) === P.brk)));
pomPaint();
pomLoop();

/* ------------------------------------------------- message actions */
/* Edit, delete and pin live in a small menu on the message rather than always
   on screen — the same reasoning as the smile: a chat with four controls under
   every line is unreadable. */
function msgMenu(m) {
  const mine = m.author.id === S.me?.id;
  const captain = S.squad?.role === 'captain';
  if (m.deleted) return '';
  return `<div class="mm">
    <button class="mm-btn" data-mm aria-label="Message actions" aria-expanded="false">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-more"/></svg></button>
    <div class="mm-pop">
      <button class="mm-i" data-act="thread">Reply in thread</button>
      <button class="mm-i" data-act="pin">${m.pinnedAt ? 'Unpin' : 'Pin to channel'}</button>
      ${mine && m.kind !== 'voice' ? '<button class="mm-i" data-act="edit">Edit</button>' : ''}
      <button class="mm-i" data-act="copy">Copy text</button>
      ${mine || captain ? '<button class="mm-i mm-danger" data-act="delete">Delete</button>' : ''}
    </div></div>`;
}

$('#msgs').addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-mm]');
  if (toggle) {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    $$('[data-mm]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    toggle.setAttribute('aria-expanded', String(!open));
    return;
  }
  const act = e.target.closest('.mm-i');
  if (!act) { $$('[data-mm]').forEach(b => b.setAttribute('aria-expanded', 'false')); return; }
  const host = act.closest('.msg');
  const id = host.dataset.msg;
  const m = S.messages.find(x => x.id === id);
  $$('[data-mm]').forEach(b => b.setAttribute('aria-expanded', 'false'));

  if (act.dataset.act === 'thread') return openThread(id);
  if (act.dataset.act === 'copy') return copyText(m?.body || '', 'message');
  if (act.dataset.act === 'pin') {
    try {
      const r = await api('POST', `/api/messages/${id}/pin`);
      if (m) { m.pinnedAt = r.pinned ? Date.now() : null; renderMessages(); }
      toast(r.pinned ? 'Pinned' : 'Unpinned', r.pinned ? 'Find it under the pin in the header.' : '', 'ok');
      loadPins();
    }
    catch (err) { toast('Could not pin', err.message); }
    return;
  }
  if (act.dataset.act === 'edit') return startEdit(host, m);
  if (act.dataset.act === 'delete') {
    if (!confirm('Delete this message? Anyone replying to it keeps their thread.')) return;
    try { await api('DELETE', `/api/messages/${id}`); }
    catch (err) { toast('Could not delete', err.message); }
  }
});

/* editing happens in place — a modal would lose the surrounding conversation */
function startEdit(host, m) {
  if (!m || host.querySelector('.edit-box')) return;
  const body = host.querySelector('.msg-body');
  const box = el('div', 'edit-box',
    `<textarea class="edit-in" rows="2"></textarea>
     <div class="edit-row"><span class="fld-help">Enter saves · Escape cancels</span>
       <button class="btn btn-sm" data-cancel>Cancel</button>
       <button class="btn btn-primary btn-sm" data-save>Save</button></div>`);
  body.after(box);
  body.hidden = true;
  const ta = $('.edit-in', box);
  ta.value = m.body;
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);

  const close = () => { box.remove(); body.hidden = false; };
  const save = async () => {
    const next = ta.value.trim();
    if (!next) return toast('Nothing to save', 'Delete the message instead.');
    if (next === m.body) return close();
    try { await api('PATCH', `/api/messages/${m.id}`, { body: next }); close(); }
    catch (err) { toast('Could not save', err.message); }
  };
  $('[data-cancel]', box).onclick = close;
  $('[data-save]', box).onclick = save;
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); }
  });
}

/* ------------------------------------------------------------ threads */
/* The parent's counter lives in the channel while the reply lives in the
   thread. The POST reply and the socket echo both carry the same reply, so
   this is keyed by id — counting it twice showed "3 replies" after one. */
const countedReplies = new Set();
function countReply(m) {
  if (!m?.parentId || countedReplies.has(m.id)) return;
  countedReplies.add(m.id);
  const parent = S.messages.find(x => x.id === m.parentId);
  if (parent) { parent.replies = (parent.replies || 0) + 1; renderMessages(); }
}

const TH = { root: null };
async function openThread(id) {
  try {
    const d = await api('GET', `/api/messages/${id}/thread`);
    TH.root = d.root.id;
    $('#thread').hidden = false;
    $('#app').dataset.thread = '1';
    renderThread(d);
    setTimeout(() => $('#thread-in').focus(), 80);
  } catch (e) { toast('Could not open that thread', e.message); }
}
function closeThread() { TH.root = null; $('#thread').hidden = true; delete $('#app').dataset.thread; }

function renderThread(d) {
  const line = (m, root) => `<article class="tmsg${root ? ' root' : ''}">
    ${avatar(m.author, 'av-s')}
    <div><div class="tmsg-h"><b>${esc(m.author.name)}</b>
      <span class="mono">${new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
      <div class="tmsg-b">${m.deleted ? '<i class="gone">message deleted</i>'
        : m.kind === 'voice' ? voiceHtml(m) : bodyHtml(m.body)}</div></div></article>`;
  $('#thread-body').innerHTML = line(d.root, true) +
    `<div class="thread-count mono">${d.replies.length} ${d.replies.length === 1 ? 'reply' : 'replies'}</div>` +
    d.replies.map(m => line(m)).join('');
  $('#thread-body').scrollTop = $('#thread-body').scrollHeight;
}
async function refreshThread() {
  if (!TH.root) return;
  try { renderThread(await api('GET', `/api/messages/${TH.root}/thread`)); } catch {}
}
$('#thread-x').onclick = closeThread;
$('#thread-send').onclick = sendReply;
$('#thread-in').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
});
async function sendReply() {
  const box = $('#thread-in'), body = box.value.trim();
  if (!body || !TH.root || !S.channel) return;
  box.value = '';
  try {
    const { message } = await api('POST', `/api/channels/${S.channel.id}/messages`, { body, parentId: TH.root });
    countReply(message);          /* the socket echo runs this too — it is idempotent */
    refreshThread();
  } catch (e) { toast('Reply not sent', e.message); box.value = body; }
}

/* --------------------------------------------------------- pagination */
async function loadOlder() {
  if (!S.channel || !S.oldest) return;
  const btn = $('#older-btn');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const d = await api('GET', `/api/channels/${S.channel.id}/messages?limit=60&before=${S.oldest}`);
    const scroller = $('#chat-scroll');
    const before = scroller.scrollHeight;
    S.messages = [...d.messages, ...S.messages];
    S.oldest = d.oldest ?? S.oldest;
    S.more = d.more;
    renderMessages();
    /* keep the reader where they were rather than yanking them to the top */
    scroller.scrollTop = scroller.scrollHeight - before;
  } catch (e) { toast('Could not load more', e.message); }
  finally { btn.disabled = false; btn.textContent = 'Load earlier messages'; $('#older').hidden = !S.more; }
}
$('#older-btn').onclick = loadOlder;

/* ----------------------------------------------------- typing indicator */
const TYPERS = new Map();
let typingSentAt = 0;
function announceTyping() {
  const t = Date.now();
  if (t - typingSentAt < 2500 || !S.squad || !S.channel) return;
  typingSentAt = t;
  safeSend({ type: 'typing', squadId: S.squad.id, channelId: S.channel.id });
}
function showTyping(name) {
  TYPERS.set(name, Date.now());
  paintTyping();
}
function paintTyping() {
  const now2 = Date.now();
  for (const [k, v] of TYPERS) if (now2 - v > 4000) TYPERS.delete(k);
  const names = [...TYPERS.keys()].map(n => n.split(' ')[0]);
  const el2 = $('#typing');
  if (!names.length) { el2.hidden = true; return; }
  el2.hidden = false;
  el2.textContent = names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : `${names.length} people are typing…`;
}
setInterval(paintTyping, 1500);

/* ------------------------------------------------------------- pins */
async function loadPins() {
  if (!S.channel) return;
  try {
    const d = await api('GET', `/api/channels/${S.channel.id}/pins`);
    S.pins = d.pins;
    const n = $('#pin-n');
    n.hidden = !d.pins.length;
    n.textContent = d.pins.length;
  } catch {}
}
$('#ch-pins').onclick = async () => {
  await loadPins();
  const pins = S.pins || [];
  modal('Pinned in #' + (S.channel?.name || ''), pins.length
    ? `<div class="pin-list">${pins.map(m => `<button class="pin-i" data-jump="${m.id}">
        <span class="pin-a">${esc(m.author.name)}</span>
        <span class="pin-b">${esc((m.body || '(voice note)').slice(0, 140))}</span></button>`).join('')}</div>`
    : '<p class="fld-help">Nothing pinned yet. Use the ⋯ menu on a message to pin the problem statement or the contest link.</p>',
  (m, close) => {
    $$('[data-jump]', m).forEach(b => b.onclick = () => { close(); jumpToMessage(b.dataset.jump); });
  });
};

function jumpToMessage(id) {
  const node = $(`#msgs .msg[data-msg="${id}"]`);
  if (!node) return toast('Further back', 'Load earlier messages to reach it.');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.dataset.flash = '1';
  setTimeout(() => node.removeAttribute('data-flash'), 1600);
}

/* ---------------------------------------------------------- mentions */
async function loadMentions() {
  try {
    const d = await api('GET', '/api/mentions');
    S.mentions = d.mentions;
    const n = $('#mention-n');
    n.hidden = !d.mentions.length;
    n.textContent = d.mentions.length;
  } catch {}
}
$('#ch-mentions').onclick = async () => {
  await loadMentions();
  const ms = S.mentions || [];
  modal('Mentions', ms.length
    ? `<div class="pin-list">${ms.map(x => `<button class="pin-i" data-go="${x.channel_id}" data-msg="${x.message_id}">
        <span class="pin-a">${esc(x.author_name)} · ${esc(x.channel_icon || '#')} ${esc(x.channel_name)}</span>
        <span class="pin-b">${esc(x.body.slice(0, 140))}</span></button>`).join('')}
       <button class="btn btn-sm" id="mn-clear" style="margin-top:10px">Mark all read</button>`
    : '<p class="fld-help">Nobody has mentioned you yet. Type @ and a handle to mention someone.</p>',
  (m, close) => {
    $$('[data-go]', m).forEach(b => b.onclick = async () => {
      close();
      const ch = S.squad?.channels.find(c => c.id === b.dataset.go);
      if (ch) { S.channel = ch; renderChannels(); await loadMessages(ch.id); setView('chat'); jumpToMessage(b.dataset.msg); }
      api('POST', '/api/mentions/read', {}).then(loadMentions);
    });
    const clear = $('#mn-clear', m);
    if (clear) clear.onclick = async () => { await api('POST', '/api/mentions/read', {}); await loadMentions(); close(); };
  });
};

/* ----------------------------------------------------------- search */
$('#ch-search').onclick = () => {
  if (!S.squad) return;
  modal('Search messages', `
    <div class="fld"><input id="sq-q" type="text" placeholder="Two characters or more" autocomplete="off"></div>
    <div class="pin-list" id="sq-out"><p class="fld-help">Searches every channel in this squad.</p></div>`,
  (m) => {
    const input = $('#sq-q', m); input.focus();
    let timer;
    input.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const term = input.value.trim();
        if (term.length < 2) { $('#sq-out', m).innerHTML = '<p class="fld-help">Keep typing…</p>'; return; }
        try {
          const d = await api('GET', `/api/squads/${S.squad.id}/search?q=${encodeURIComponent(term)}`);
          $('#sq-out', m).innerHTML = d.hits.length
            ? d.hits.map(h => `<button class="pin-i" data-go="${h.channel_id}" data-msg="${h.id}">
                <span class="pin-a">${esc(h.author_name)} · ${esc(h.channel_icon || '#')} ${esc(h.channel_name)}
                  · ${new Date(h.created_at).toLocaleDateString()}</span>
                <span class="pin-b">${esc(h.body.slice(0, 160))}</span></button>`).join('')
            : '<p class="fld-help">Nothing matched.</p>';
          $$('[data-go]', m).forEach(b => b.onclick = async () => {
            $('#modal').hidden = $('#modal-scrim').hidden = true;
            const ch = S.squad.channels.find(c => c.id === b.dataset.go);
            if (ch) { S.channel = ch; renderChannels(); await loadMessages(ch.id); setView('chat'); jumpToMessage(b.dataset.msg); }
          });
        } catch (e) { $('#sq-out', m).innerHTML = `<p class="gate-error">${esc(e.message)}</p>`; }
      }, 220);
    };
  });
};

/* ------------------------------------------------------------- settings */
/* Note on passwords: this panel never shows one, because the server does not
   have one to show. Sign-up stores a scrypt hash with a per-account salt, so a
   copy of the database is not a list of everyone's password — and recovering
   the original from the hash is not something the server can do either. The
   only sensible offer is to change it, which requires the current one. */
const SET = { tab: 'profile', data: null, busy: false };

async function openSettings(tab) {
  SET.tab = tab || 'profile';
  $('#set').hidden = $('#set-scrim').hidden = false;
  document.body.classList.add('set-open');
  $('#set-body').innerHTML = '<p class="set-load">Loading your account…</p>';
  try {
    SET.data = await api('GET', '/api/me/account');
    renderSettings();
  } catch (e) {
    $('#set-body').innerHTML = `<p class="gate-error">${esc(e.message)}</p>`;
  }
  setTimeout(() => $('#set .set-tab[aria-selected="true"]')?.focus(), 60);
}
function closeSettings() {
  $('#set').hidden = $('#set-scrim').hidden = true;
  document.body.classList.remove('set-open');
}

const joinedOn = (ms) => new Date(ms || Date.now())
  .toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });

function renderSettings() {
  const u = SET.data.user;
  $$('.set-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.set === SET.tab)));
  const body = $('#set-body');

  if (SET.tab === 'profile') {
    body.innerHTML = `
      <div class="set-id">
        <span class="av av-xl" style="background:${tint(u.id)}">${esc(initials(u.name))}</span>
        <div><div class="set-id-n">${esc(u.name)}</div>
          <div class="set-id-h mono">${esc(u.handle)}</div></div>
      </div>

      <form class="set-sec" id="pf-form">
        <span class="eyebrow">Your details</span>
        <div class="fld"><label for="pf-name">Display name</label>
          <input id="pf-name" type="text" maxlength="60" value="${esc(u.name)}" autocomplete="name">
          <p class="fld-help">What the squad sees on your messages and on the board.</p></div>
        <div class="fld"><label for="pf-handle">Handle</label>
          <input id="pf-handle" type="text" maxlength="20" value="${esc(u.handle)}" autocomplete="off">
          <p class="fld-help">Lowercase, letters, numbers and underscores. Has to be unique.</p></div>
        <div class="fld"><label for="pf-rating">Rating <span class="wz-opt">optional</span></label>
          <input id="pf-rating" type="number" min="0" max="4000" value="${u.rating ?? ''}" placeholder="e.g. 1642">
          <p class="fld-help">Your competitive rating, if you want it on your profile.</p></div>
        <p class="gate-error" id="pf-err" hidden></p>
        <div class="set-row"><button class="btn btn-primary" id="pf-save" type="submit">Save changes</button>
          <span class="set-note mono" id="pf-note"></span></div>
      </form>`;

    $('#pf-form').onsubmit = async (e) => {
      e.preventDefault();
      if (SET.busy) return;
      SET.busy = true;
      const err = $('#pf-err'); err.hidden = true;
      try {
        const { user } = await api('PATCH', '/api/me', {
          name: $('#pf-name').value,
          handle: $('#pf-handle').value,
          rating: $('#pf-rating').value
        });
        SET.data.user = user;
        S.me = { ...S.me, ...user };
        paintMe();
        renderSettings();
        $('#pf-note').textContent = 'saved';
        toast('Profile updated', user.name, 'ok');
        /* the name and handle are printed on every message already on screen */
        if (S.channel) loadMessages(S.channel.id);
        renderRoster?.();
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
      finally { SET.busy = false; }
    };
    return;
  }

  if (SET.tab === 'security') {
    body.innerHTML = `
      <div class="set-sec">
        <span class="eyebrow">Password</span>
        <div class="set-why">
          <svg class="icon icon-sm" aria-hidden="true"><use href="#i-lock"/></svg>
          <p><b>Your password cannot be shown here.</b> It is stored as a scrypt hash with its own
             random salt, never as text — so nobody with a copy of this database, including this
             page, can read it back. That is what keeps it safe. You can replace it below.</p>
        </div>
        <form id="pw-form">
          <div class="fld"><label for="pw-cur">Current password</label>
            <input id="pw-cur" type="password" autocomplete="current-password"></div>
          <div class="fld"><label for="pw-new">New password</label>
            <input id="pw-new" type="password" autocomplete="new-password" minlength="8">
            <p class="fld-help">At least eight characters.</p></div>
          <div class="fld"><label for="pw-again">Repeat the new password</label>
            <input id="pw-again" type="password" autocomplete="new-password"></div>
          <p class="gate-error" id="pw-err" hidden></p>
          <button class="btn btn-primary" id="pw-save" type="submit">Change password</button>
        </form>
      </div>

      <div class="set-sec">
        <span class="eyebrow">Sign-in address</span>
        <form id="em-form">
          <div class="fld"><label for="em-new">Email</label>
            <input id="em-new" type="email" value="${esc(SET.data.user.email)}" autocomplete="email">
            <p class="fld-help">This is what you sign in with. Squadron never sends mail to it.</p></div>
          <div class="fld"><label for="em-pw">Your password</label>
            <input id="em-pw" type="password" autocomplete="current-password">
            <p class="fld-help">Confirms it is you before the address changes.</p></div>
          <p class="gate-error" id="em-err" hidden></p>
          <button class="btn" id="em-save" type="submit">Update email</button>
        </form>
      </div>

      <div class="set-sec">
        <span class="eyebrow">Sessions</span>
        <p class="fld-help">Signed in on <b>${SET.data.sessions}</b> device${SET.data.sessions === 1 ? '' : 's'},
          counting this one.</p>
        <button class="btn" id="sess-end" ${SET.data.sessions < 2 ? 'disabled' : ''}>Sign out everywhere else</button>
      </div>`;

    $('#pw-form').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#pw-err'); err.hidden = true;
      if ($('#pw-new').value !== $('#pw-again').value) {
        err.textContent = 'The two new passwords do not match.'; err.hidden = false; return;
      }
      $('#pw-save').disabled = true;
      try {
        await api('POST', '/api/me/password', { current: $('#pw-cur').value, next: $('#pw-new').value });
        toast('Password changed', 'Any other device is now signed out.', 'ok');
        SET.data = await api('GET', '/api/me/account');
        renderSettings();
      } catch (e2) { err.textContent = e2.message; err.hidden = false; $('#pw-save').disabled = false; }
    };

    $('#em-form').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#em-err'); err.hidden = true;
      $('#em-save').disabled = true;
      try {
        const { user } = await api('POST', '/api/me/email', { email: $('#em-new').value, password: $('#em-pw').value });
        SET.data.user = user; S.me = { ...S.me, ...user };
        toast('Email updated', user.email, 'ok');
        renderSettings();
      } catch (e2) { err.textContent = e2.message; err.hidden = false; $('#em-save').disabled = false; }
    };

    const endBtn = $('#sess-end');
    if (endBtn) endBtn.onclick = async () => {
      endBtn.disabled = true;
      try {
        const r = await api('POST', '/api/me/sessions/end-others');
        toast('Signed out elsewhere', `${r.ended} other session${r.ended === 1 ? '' : 's'} ended.`, 'ok');
        SET.data = await api('GET', '/api/me/account');
        renderSettings();
      } catch (e2) { toast('Could not do that', e2.message); endBtn.disabled = false; }
    };
    return;
  }

  /* account */
  const c = SET.data.counts;
  body.innerHTML = `
    <div class="set-sec">
      <span class="eyebrow">This account</span>
      <dl class="set-facts">
        <div><dt>Email</dt><dd>${esc(SET.data.user.email)}</dd></div>
        <div><dt>Handle</dt><dd class="mono">${esc(SET.data.user.handle)}</dd></div>
        <div><dt>Joined</dt><dd>${esc(joinedOn(SET.data.user.createdAt))}</dd></div>
        <div><dt>XP</dt><dd>${SET.data.xp}</dd></div>
      </dl>
    </div>

    <div class="set-sec">
      <span class="eyebrow">What you have done</span>
      <div class="set-stats">
        <div class="set-stat"><b class="mono">${c.messages}</b><span>messages</span></div>
        <div class="set-stat"><b class="mono">${c.solved}</b><span>tasks solved</span></div>
        <div class="set-stat"><b class="mono">${c.snippets}</b><span>files written</span></div>
      </div>
    </div>

    <div class="set-sec">
      <span class="eyebrow">Squads</span>
      ${SET.data.squads.length
        ? `<div class="set-squads">${SET.data.squads.map(sq => `
            <div class="set-squad"><span class="av av-s" style="background:${tint(sq.id)}">${esc(initials(sq.name))}</span>
              <span class="set-squad-b"><span class="set-squad-n">${esc(sq.name)}</span>
              <span class="set-squad-r mono">${esc(sq.role)}</span></span>
              <button class="set-leave" data-leave="${sq.id}" data-name="${esc(sq.name)}"
                data-role="${sq.role}">Leave</button></div>`).join('')}</div>`
        : '<p class="fld-help">You are not in a squad yet.</p>'}
    </div>

    <div class="set-sec">
      <span class="eyebrow">Walk-through</span>
      <p class="fld-help">The guided tour is offered once. Run it again whenever you like.</p>
      <button class="btn" id="set-tour">Take the tour</button>
    </div>

    <div class="set-sec set-danger">
      <span class="eyebrow">Leaving</span>
      <p class="fld-help">Signs you out on this device only. Your squads and work stay where they are.</p>
      <button class="btn btn-quiet-danger" id="set-signout">
        <svg class="icon icon-sm" aria-hidden="true"><use href="#i-logout"/></svg>Sign out</button>
      <hr class="set-rule">
      <p class="fld-help"><b>Closing the account</b> removes your squad memberships, your personal
        files and your messages, and scrubs your name and email. Messages you sent become
        <i>“Deleted member”</i> so other people's conversations stay readable. It cannot be undone.</p>
      <button class="btn btn-quiet-danger" id="set-close-acct">Close my account…</button>
    </div>`;

  $('#set-tour').onclick = () => { closeSettings(); setTimeout(startTour, 260); };
  $('#set-signout').onclick = () => { closeSettings(); signOut(); };
  $$('[data-leave]').forEach(b => b.onclick = () => leaveSquadDialog(b.dataset.leave, b.dataset.name, b.dataset.role));
  $('#set-close-acct').onclick = closeAccountDialog;
}

function leaveSquadDialog(id, name, role) {
  const sq = S.squads.find(x => x.id === id);
  const others = (sq?.members || []).filter(m => m.id !== S.me?.id);
  const lastOne = role === 'captain' && !others.length;
  modal('Leave ' + name, `
    ${lastOne
      ? '<p class="fld-help">You are the only person here, so leaving <b>deletes the squad</b> and everything in it — channels, messages, board and files.</p>'
      : role === 'captain'
        ? `<div class="fld"><label for="lv-heir">Hand the squad to</label>
             <select id="lv-heir">${others.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
             <p class="fld-help">A squad needs a captain, so someone has to take it before you go.</p></div>`
        : '<p class="fld-help">Your messages stay where they are. You can be invited back at any time.</p>'}
    <p class="gate-error" id="lv-err" hidden></p>
    <button class="btn btn-quiet-danger btn-lg" id="lv-go" style="width:100%;justify-content:center">
      ${lastOne ? 'Delete this squad' : 'Leave ' + esc(name)}</button>`,
  (m, close) => {
    $('#lv-go', m).onclick = async () => {
      $('#lv-go', m).disabled = true;
      try {
        await api('POST', `/api/squads/${id}/leave`, { handTo: $('#lv-heir', m)?.value || null });
        close(); closeSettings();
        toast(lastOne ? 'Squad deleted' : 'You left ' + name, '', 'ok');
        S.squad = null;
        await loadSquads();
      } catch (e) { $('#lv-err', m).textContent = e.message; $('#lv-err', m).hidden = false; $('#lv-go', m).disabled = false; }
    };
  });
}

function closeAccountDialog() {
  modal('Close your account', `
    <div class="set-why">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-lock"/></svg>
      <p>This removes your memberships, personal files, reactions and messages, and replaces
         your name and email with a placeholder. Anything you wrote in a shared channel becomes
         <b>“Deleted member”</b> rather than vanishing, so nobody else loses their thread.
         <b>There is no undo.</b></p>
    </div>
    <div class="fld"><label for="ca-pw">Your password</label>
      <input id="ca-pw" type="password" autocomplete="current-password"></div>
    <div class="fld"><label for="ca-confirm">Type <b>delete</b> to confirm</label>
      <input id="ca-confirm" type="text" autocomplete="off" placeholder="delete"></div>
    <p class="gate-error" id="ca-err" hidden></p>
    <button class="btn btn-quiet-danger btn-lg" id="ca-go" style="width:100%;justify-content:center">
      Close my account permanently</button>`,
  (m) => {
    $('#ca-go', m).onclick = async () => {
      $('#ca-go', m).disabled = true;
      try {
        await api('POST', '/api/me/delete', { password: $('#ca-pw', m).value, confirm: $('#ca-confirm', m).value });
        location.href = '/';
      } catch (e) { $('#ca-err', m).textContent = e.message; $('#ca-err', m).hidden = false; $('#ca-go', m).disabled = false; }
    };
  });
}

/* the sidebar card mirrors whatever settings just changed */
function paintMe() {
  if (!S.me) return;
  $('#me-name').textContent = S.me.name;
  $('#me-av').textContent = initials(S.me.name);
  $('#me-av').style.background = tint(S.me.id);
  $('#xp-name').textContent = S.me.name;
}

/* Adding people was buried in the squad panel, which is hidden on anything
   narrower than 1280px and whenever the compiler or a thread is open. */
$('#sw-invite').onclick = () => { closeSw(); if (S.squad) inviteDialog(); else toast('Make a squad first', 'There is nobody to add to yet.'); };

$('#me-open').onclick = () => openSettings('profile');
$('#open-settings').onclick = () => openSettings('profile');
$('#set-x').onclick = closeSettings;
$('#set-scrim').onclick = closeSettings;
$$('.set-tab').forEach(b => b.onclick = () => { SET.tab = b.dataset.set; renderSettings(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#set').hidden) closeSettings(); });

/* ------------------------------------------------- test cases + library */
/* A case is an input and, optionally, the output it should produce. Leaving
   expected blank means "just run it and show me" — useful before you know the
   answer. Cases are compiled once and run in sequence on the server. */
C.cases = [];

async function loadCases() {
  if (!C.cur) { C.cases = []; return renderCases(); }
  try { C.cases = (await api('GET', `/api/snippets/${C.cur.id}/tests`)).tests; }
  catch { C.cases = []; }
  renderCases();
}

function renderCases() {
  const n = C.cases.length;
  $('#cases-sum').textContent = n ? `${n}` : '';
  $('#code-test-n').textContent = n ? ` (${n})` : '';
  $('#code-test').disabled = !n || (C.runner && !C.runner.ok);
  $('#cases-list').innerHTML = C.cases.map((t, i) => `
    <div class="case" data-case="${t.id}" data-state="${t._state || ''}">
      <div class="case-h">
        <span class="case-dot"></span>
        <input class="case-n" value="${esc(t.name)}" maxlength="40" aria-label="Case name">
        <span class="case-r mono">${t._note || ''}</span>
        <button class="case-x" data-del aria-label="Remove this case">×</button>
      </div>
      <div class="case-io">
        <label>Input<textarea class="case-in" rows="2" spellcheck="false">${esc(t.stdin)}</textarea></label>
        <label>Expected<textarea class="case-out" rows="2" spellcheck="false"
          placeholder="leave blank to just run it">${esc(t.expected)}</textarea></label>
      </div>
      ${t._got !== undefined ? `<pre class="case-got">${esc(t._got || '(no output)')}</pre>` : ''}
    </div>`).join('');
}

$('#case-add').onclick = async () => {
  if (!C.cur) return;
  try {
    const { test } = await api('POST', `/api/snippets/${C.cur.id}/tests`, { name: `case ${C.cases.length + 1}` });
    C.cases.push(test); renderCases();
  } catch (e) { toast('Could not add a case', e.message); }
};

$('#cases-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  const id = del.closest('.case').dataset.case;
  try { await api('DELETE', `/api/tests/${id}`); C.cases = C.cases.filter(t => t.id !== id); renderCases(); }
  catch (err) { toast('Could not remove it', err.message); }
});

/* Edits save on a debounce. The timer is per case — one shared timer meant
   filling in three cases quickly saved only the last one, and the others ran
   with empty input. */
const caseTimers = new Map();
function queueCaseSave(box) {
  const id = box.dataset.case;
  clearTimeout(caseTimers.get(id));
  caseTimers.set(id, setTimeout(async () => {
    caseTimers.delete(id);
    const t = C.cases.find(x => x.id === id);
    if (!t) return;
    const payload = {
      name: $('.case-n', box).value,
      stdin: $('.case-in', box).value,
      expected: $('.case-out', box).value
    };
    Object.assign(t, payload);
    try { await api('PATCH', `/api/tests/${id}`, payload); }
    catch (e) { toast('Case not saved', e.message); }
  }, 500));
}
/* anything still queued must land before a run, or it runs stale input */
async function flushCases() {
  const pending = [...caseTimers.keys()];
  for (const id of pending) {
    clearTimeout(caseTimers.get(id)); caseTimers.delete(id);
    const box = $(`.case[data-case="${id}"]`);
    const t = C.cases.find(x => x.id === id);
    if (!box || !t) continue;
    const payload = { name: $('.case-n', box).value, stdin: $('.case-in', box).value, expected: $('.case-out', box).value };
    Object.assign(t, payload);
    try { await api('PATCH', `/api/tests/${id}`, payload); } catch {}
  }
}
$('#cases-list').addEventListener('input', (e) => {
  const box = e.target.closest('.case');
  if (box) queueCaseSave(box);
});

async function runCases() {
  if (!C.cur || !C.cases.length || C.busy) return;
  await flushSnippet();
  await flushCases();
  C.busy = true;
  const btn = $('#code-test');
  btn.disabled = true; btn.dataset.busy = '1';
  $('#code-out').textContent = `Running ${C.cases.length} case${C.cases.length === 1 ? '' : 's'}…`;
  $('#code-out').dataset.state = 'wait';
  try {
    const r = await api('POST', `/api/snippets/${C.cur.id}/run-tests`, { source: $('#code-area').value, lang: $('#code-lang').value });
    if (r.stage === 'compile' || r.stage === 'blocked') {
      $('#code-out').textContent = r.stderr;
      $('#code-out').dataset.state = 'bad';
      $('#code-meta').textContent = r.stage === 'compile' ? 'did not compile' : 'blocked';
      C.cases.forEach(t => { t._state = ''; t._note = ''; delete t._got; });
      renderCases();
      return;
    }
    const byId = Object.fromEntries(r.results.map(x => [x.id, x]));
    C.cases.forEach(t => {
      const res = byId[t.id];
      if (!res) return;
      t._state = res.passed ? 'pass' : 'fail';
      t._note = res.timedOut ? 'timed out' : res.passed ? 'pass' : (res.exitCode !== 0 ? 'error' : 'mismatch');
      t._got = res.stderr && !res.stdout ? res.stderr : res.stdout;
    });
    renderCases();
    $('#code-cases').open = true;
    const failed = r.results.filter(x => !x.passed);
    $('#code-out').textContent = failed.length
      ? failed.map(f => `${f.name}: ${f.timedOut ? 'timed out' : f.exitCode !== 0 ? (f.stderr.trim().split('\n').pop() || 'runtime error') : `expected ${JSON.stringify(f.expected.trim())}, got ${JSON.stringify(f.stdout.trim())}`}`).join('\n')
      : `All ${r.total} case${r.total === 1 ? '' : 's'} passed.`;
    $('#code-out').dataset.state = r.ok ? 'ok' : 'bad';
    $('#code-meta').textContent = `${r.passed}/${r.total} passed · ${r.ms} ms`;
  } catch (e) {
    $('#code-out').textContent = e.message;
    $('#code-out').dataset.state = 'bad';
  } finally { C.busy = false; btn.disabled = false; delete btn.dataset.busy; }
}
$('#code-test').onclick = runCases;

/* ---- the squad's shared header library ---- */
$('#code-lib').onclick = () => {
  if (!C.cur || C.cur.scope !== 'team') return;
  modal('Team library', `
    <div class="set-why">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-code"/></svg>
      <p>Give this file a filename and every run in the squad can
        <code>#include "that name"</code> — one copy of the DSU or the segment tree
        that everybody compiles against.</p>
    </div>
    <div class="fld"><label for="lib-name">Include as</label>
      <input id="lib-name" type="text" value="${esc(C.cur.includeAs || '')}" placeholder="dsu.h" maxlength="40">
      <p class="fld-help">Letters, numbers, dots, dashes and underscores. Clear it to take the file out of the library.</p></div>
    <div class="fld"><label>Already in the library</label><div class="pin-list" id="lib-list"></div></div>
    <p class="gate-error" id="lib-err" hidden></p>
    <button class="btn btn-primary btn-lg" id="lib-go" style="width:100%;justify-content:center">Save</button>`,
  (m, close) => {
    api('GET', `/api/squads/${S.squad.id}/library`).then(d => {
      $('#lib-list', m).innerHTML = d.library.length
        ? d.library.map(x => `<div class="pin-i"><span class="pin-a mono">${esc(x.include_as)}</span>
            <span class="pin-b">${esc(x.title)}</span></div>`).join('')
        : '<p class="fld-help">Nothing in it yet.</p>';
    }).catch(() => {});
    $('#lib-go', m).onclick = async () => {
      try {
        const r = await api('POST', `/api/snippets/${C.cur.id}/include`, { name: $('#lib-name', m).value });
        C.cur.includeAs = r.includeAs;
        close();
        toast(r.includeAs ? 'In the library' : 'Removed from the library',
          r.includeAs ? `#include "${r.includeAs}"` : '', 'ok');
        loadSnippets();
      } catch (e) { $('#lib-err', m).textContent = e.message; $('#lib-err', m).hidden = false; }
    };
  });
};

/* a board snapshot is unreadable at thumbnail size on a phone */
document.addEventListener('click', (e) => {
  const img = e.target.closest('img[data-zoom]');
  if (!img) return;
  const box = el('div', 'zoom', `<img src="${img.src}" alt="">`);
  box.onclick = () => box.remove();
  document.body.appendChild(box);
  addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape') { box.remove(); removeEventListener('keydown', esc); }
  });
});

/* ------------------------------------------------------ direct messages */
/* A separate surface from channels: same renderer for the body so code blocks
   and pictures behave identically, but its own thread list and read marks. */
const DM = { thread: null, other: null, messages: [], oldest: null, more: false, theirRead: 0 };

async function loadDmList() {
  try {
    const d = await api('GET', '/api/dms');
    S.dmThreads = d.threads;
    S.dmPeople = d.people;
    if (S.squad) renderChannels();
  } catch {}
}

async function openDm(id) {
  try {
    const d = await api('GET', `/api/dms/${id}/messages?limit=60`);
    DM.thread = d.thread; DM.other = d.other; DM.messages = d.messages;
    $('#dm-in').placeholder = 'Message ' + d.other.name.split(' ')[0];
    DM.oldest = d.oldest; DM.more = !!d.more; DM.theirRead = d.theirRead;
    $('#dm-older').hidden = !d.more;
    setView('dm');
    renderDm();
    $('#dm-in').focus();
    await api('POST', `/api/dms/${id}/read`).catch(() => {});
    const t = (S.dmThreads || []).find(x => x.id === id);
    if (t) t.unread = 0;
    renderChannels();
  } catch (e) { toast('Could not open that conversation', e.message); }
}

function renderDm() {
  /* who you are talking to, stated once — the top bar alone was easy to miss */
  const head = $('#dm-head');
  if (head && DM.other) {
    head.innerHTML = `${avatar(DM.other, 'av-m')}
      <span class="dm-head-b"><span class="dm-head-n">${esc(DM.other.name)}</span>
        <span class="dm-head-s mono">${esc(DM.other.handle)} · just the two of you</span></span>`;
  }
  const box = $('#dm-msgs');
  if (!DM.messages.length) {
    box.innerHTML = `<div class="hollow">
      <span class="av av-xl" style="background:${tint(DM.other?.id || '')}">${esc(initials(DM.other?.name || ''))}</span>
      <h3>${esc(DM.other?.name || '')}</h3>
      <p>Nothing here yet. Anything you send stays between the two of you —
         code, a whiteboard page, or just a question.</p>
      <button class="btn btn-primary btn-sm" data-focus-dm>Say hello</button></div>`;
    $('[data-focus-dm]', box)?.addEventListener('click', () => $('#dm-in').focus());
    return;
  }
  /* whose message this is depends on who is looking, so work it out here
     rather than trusting a flag that may have been shaped for the sender */
  const isMine = (m) => m.author.id === S.me?.id;
  const lastSeenDm = [...DM.messages].reverse()
    .find(x => isMine(x) && DM.theirRead >= x.created_at)?.id || null;
  let last = null;
  box.innerHTML = DM.messages.map(m => {
    const newDay = !last || dayStamp(last.created_at) !== dayStamp(m.created_at);
    const sep = newDay ? daySep(m.created_at) : '';
    const cont = !newDay && last && last.author.id === m.author.id && (m.created_at - last.created_at) < 3e4;
    last = m;
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const seen = m.id === lastSeenDm;
    const mine = isMine(m);
    return sep + `<article class="msg${cont ? ' cont' : ''}${mine ? ' mine' : ''}${m.deleted ? ' gone-msg' : ''}" data-dmm="${m.id}">
      ${mine ? '' : cont ? `<span class="av av-m" aria-hidden="true" style="background:${tint(m.author.id)};opacity:0"></span>` : avatar(m.author, 'av-m')}
      <div><div class="msg-head"><span class="msg-name">${mine ? 'You' : esc(m.author.name)}</span>
        <span class="msg-time mono">${time}</span></div>
        <div class="msg-wrap"><div class="msg-body">${
          m.deleted ? '<p class="gone">This message was deleted</p>'
          : (m.body ? bodyHtml(m.body) : '') +
            (m.image ? `<img class="msg-img" src="/api/images/${m.image}" alt="Shared picture" loading="lazy" data-zoom>` : '') + fileHtml(m.file)
        }${m.editedAt && !m.deleted ? '<span class="edited mono">edited</span>' : ''}</div></div>
        ${seen ? '<div class="seen"><span class="seen-t">Seen</span></div>' : ''}</div>
      ${mine && !m.deleted ? '<div class="mm"><button class="mm-btn" data-dm-mm aria-label="Message actions" aria-expanded="false"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-more"/></svg></button><div class="mm-pop"><button class="mm-i" data-dm-copy>Copy text</button><button class="mm-i mm-danger" data-dm-del>Delete</button></div></div>' : ''}
    </article>`;
  }).join('');
  $('#dm-scroll').scrollTop = $('#dm-scroll').scrollHeight;
}

$('#dm-msgs').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-dm-mm]');
  if (t) {
    const open = t.getAttribute('aria-expanded') === 'true';
    $$('[data-dm-mm]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    t.setAttribute('aria-expanded', String(!open));
    return;
  }
  const host = e.target.closest('.msg');
  if (e.target.closest('[data-dm-copy]')) {
    const m = DM.messages.find(x => x.id === host.dataset.dmm);
    $$('[data-dm-mm]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    return copyText(m?.body || '', 'message');
  }
  if (e.target.closest('[data-dm-del]')) {
    $$('[data-dm-mm]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    if (!confirm('Delete this message?')) return;
    try { await api('DELETE', `/api/dm-messages/${host.dataset.dmm}`); }
    catch (err) { toast('Could not delete', err.message); }
    return;
  }
  $$('[data-dm-mm]').forEach(b => b.setAttribute('aria-expanded', 'false'));
});

async function sendDm(extra) {
  const box = $('#dm-in'), body = box.value.trim();
  if (!DM.thread) return;
  if (!extra && ATT.dm) {
    box.value = ''; box.style.height = 'auto';
    try { await sendStaged('dm', body); } catch { box.value = body; }
    return;
  }
  if (!body && !extra?.imageId) return;
  box.value = ''; box.style.height = 'auto';
  try {
    await api('POST', `/api/dms/${DM.thread.id}/messages`, { body, ...(extra || {}) });
  } catch (e) { toast('Not sent', e.message); box.value = body; }
}
$('#dm-send').onclick = () => sendDm();
$('#dm-in').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDm(); }
});
$('#dm-in').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
});
wireAttach('dm', '#dm-file-btn', '#dm-file-input', '#dm-in', '#v-dm');

$('#dm-attach').onclick = async () => {
  if (!DM.thread) return;
  const img = await uploadBoardPng();
  if (img) sendDm({ imageId: img.id });
};
$('#dm-older-btn').onclick = async () => {
  if (!DM.thread || !DM.oldest) return;
  const btn = $('#dm-older-btn'); btn.disabled = true;
  try {
    const d = await api('GET', `/api/dms/${DM.thread.id}/messages?limit=60&before=${DM.oldest}`);
    const sc = $('#dm-scroll'), before = sc.scrollHeight;
    DM.messages = [...d.messages, ...DM.messages];
    DM.oldest = d.oldest ?? DM.oldest; DM.more = d.more;
    renderDm();
    sc.scrollTop = sc.scrollHeight - before;
  } catch (e) { toast('Could not load more', e.message); }
  finally { btn.disabled = false; $('#dm-older').hidden = !DM.more; }
};

function newDmDialog(preset) {
  const people = S.dmPeople || [];
  if (!people.length) return toast('Nobody to message yet', 'Invite someone to a squad first.');
  modal('Message someone', `
    <div class="fld"><label for="nd-who">Who</label>
      <select id="nd-who">${people.map(p => `<option value="${p.id}" ${p.id === preset ? 'selected' : ''}>${esc(p.name)} · ${esc(p.handle)}</option>`).join('')}</select>
      <p class="fld-help">Anyone you share a squad with.</p></div>
    <p class="gate-error" id="nd-err" hidden></p>
    <button class="btn btn-primary btn-lg" id="nd-go" style="width:100%;justify-content:center">Open the conversation</button>`,
  (m, close) => {
    $('#nd-go', m).onclick = async () => {
      try {
        const { thread } = await api('POST', '/api/dms', { userId: $('#nd-who', m).value });
        close();
        await loadDmList();
        openDm(thread.id);
      } catch (e) { $('#nd-err', m).textContent = e.message; $('#nd-err', m).hidden = false; }
    };
  });
}

/* ---------------------------------------------------------- whiteboard */
/* Everything is stored as geometry, not pixels: a stroke is its points, a
   shape is two corners, a label is an anchor and a string. That means any
   screen size renders the same board, a late joiner replays it exactly, and
   exporting is just painting it again at whatever resolution you ask for. */
const W = 1600, H = 1000;
const D = { strokes: [], drawing: null, colour: '#E9B949', width: 3, tool: 'pen', fill: false,
            board: null, pages: [], loaded: null };
const PENS = ['#E9B949', '#5E9BF7', '#5DBE8A', '#E86D74', '#C792EA', '#E8ECF5'];
const FONT_STACK = {
  sans:  '"Instrument Sans", system-ui, sans-serif',
  serif: 'Fraunces, Georgia, serif',
  mono:  '"JetBrains Mono", ui-monospace, monospace'
};

function boardCtx(target, scale) {
  const cv = target || $('#draw-canvas');
  if (!cv) return null;
  if (!target) {
    const r = $('#draw-wrap').getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const h = Math.max(200, Math.min(r.height - 2, (r.width - 2) * H / W));
    cv.style.width = (h * W / H) + 'px';
    cv.style.height = h + 'px';
    cv.width = Math.round(h * W / H * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
  return ctx;
}

function drawShape(ctx, s) {
  const p = s.points || [];
  if (!p.length) return;
  ctx.strokeStyle = s.colour || '#E9B949';
  ctx.fillStyle = s.colour || '#E9B949';
  ctx.lineWidth = s.width || 3;
  const [x1, y1] = p[0], [x2, y2] = p[p.length - 1];

  if (s.kind === 'text') {
    const size = s.size || 28;
    ctx.font = `${size}px ${FONT_STACK[s.font] || FONT_STACK.sans}`;
    ctx.textBaseline = 'top';
    /* a label can be several lines, the way a text box on paper is */
    String(s.text || '').split('\n').forEach((line, i) => ctx.fillText(line, x1, y1 + i * size * 1.25));
    return;
  }
  if (s.kind === 'rect') {
    const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if (s.fill) { ctx.globalAlpha = 0.22; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; }
    ctx.strokeRect(x, y, w, h);
    return;
  }
  if (s.kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    if (s.fill) { ctx.globalAlpha = 0.22; ctx.fill(); ctx.globalAlpha = 1; }
    ctx.stroke();
    return;
  }
  if (s.kind === 'line' || s.kind === 'arrow') {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    if (s.kind === 'arrow') {
      const a = Math.atan2(y2 - y1, x2 - x1), head = 9 + (s.width || 3) * 2.2;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(a - 0.42), y2 - head * Math.sin(a - 0.42));
      ctx.lineTo(x2 - head * Math.cos(a + 0.42), y2 - head * Math.sin(a + 0.42));
      ctx.closePath(); ctx.fill();
    }
    return;
  }
  /* pen */
  if (p.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(p[0][0], p[0][1]);
  for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
  ctx.stroke();
}

function paintBoard(target, opaque) {
  const ctx = boardCtx(target);
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  if (opaque) { ctx.fillStyle = '#0D0F17'; ctx.fillRect(0, 0, W, H); }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  D.strokes.forEach(s => drawShape(ctx, s));
  if (D.drawing) drawShape(ctx, D.drawing);
}

async function loadPages() {
  if (!S.squad) return;
  try {
    const d = await api('GET', `/api/squads/${S.squad.id}/boards`);
    D.pages = d.boards;
    if (!D.pages.some(p => p.id === D.board)) D.board = D.pages[0]?.id || null;
    renderPages();
  } catch {}
}

/* the label says whose page this is, because the answer changes what you draw */
function paintNote() {
  const cur = D.pages.find(p => p.id === D.board);
  const note = $('#draw-note');
  if (!note) return;
  note.innerHTML =
    `<span class="draw-scope" data-scope="${cur?.scope || 'team'}">${cur?.scope === 'personal' ? 'Only you' : 'Shared with the squad'}</span>`
    + ` · ${D.strokes.length} mark${D.strokes.length === 1 ? '' : 's'}`;
}

function renderPages() {
  const team = D.pages.filter(p => p.scope !== 'personal');
  const mine = D.pages.filter(p => p.scope === 'personal');
  const tab = (p) => `
    <span class="page-slot">
      <button class="page${p.id === D.board ? ' on' : ''}${p.scope === 'personal' ? ' priv' : ''}" data-page="${p.id}"
        title="${p.id === D.board ? 'Rename or delete this page' : 'Open ' + esc(p.name)}">
        ${p.scope === 'personal' ? '<svg class="icon" style="width:10px;height:10px" aria-hidden="true"><use href="#i-lock"/></svg>' : ''}
        <span>${esc(p.name)}</span><span class="page-n mono">${p.marks}</span></button>
      ${(p.scope === 'personal' || team.length > 1) ? `<button class="page-x" data-del-page="${p.id}" aria-label="Delete ${esc(p.name)}" title="Delete this page">×</button>` : ''}
    </span>`;
  $('#draw-pages').innerHTML =
    `<span class="page-lane"><span class="page-lane-l">Shared</span>${team.map(tab).join('')}
       <button class="page page-new" data-new-page="team" title="Add a shared page">+</button></span>
     <span class="page-sep" aria-hidden="true"></span>
     <span class="page-lane"><span class="page-lane-l">Only me</span>${mine.map(tab).join('')}
       <button class="page page-new" data-new-page="personal" title="Add a private page">+</button></span>`;
}

$('#draw-pages').addEventListener('click', async (e) => {
  const add = e.target.closest('[data-new-page]');
  if (add) {
    const scope = add.dataset.newPage;
    try {
      const { board } = await api('POST', `/api/squads/${S.squad.id}/boards`, { scope });
      await loadPages();
      D.board = board.id; D.loaded = null; await openBoard();
      toast(scope === 'personal' ? 'Private page added' : 'Shared page added',
        scope === 'personal' ? 'Only you can see this one.' : 'Everyone in the squad can draw here.', 'ok');
    } catch (err) { toast('Could not add a page', err.message); }
    return;
  }
  const del = e.target.closest('[data-del-page]');
  if (del) return deletePageDialog(del.dataset.delPage);
  const b = e.target.closest('[data-page]');
  if (!b) return;
  if (b.dataset.page === D.board) return renamePage(b.dataset.page);
  D.board = b.dataset.page; D.loaded = null; await openBoard();
});

function renamePage(id) {
  const page = D.pages.find(p => p.id === id);
  modal('Page', `
    <div class="fld"><label for="pg-name">Name</label>
      <input id="pg-name" type="text" maxlength="40" value="${esc(page?.name || '')}"></div>
    <p class="gate-error" id="pg-err" hidden></p>
    <div class="set-row"><button class="btn btn-primary" id="pg-save">Save</button>
      <button class="btn btn-quiet-danger" id="pg-del" style="margin-left:auto">Delete this page</button></div>`,
  (m, close) => {
    $('#pg-save', m).onclick = async () => {
      try { await api('PATCH', `/api/boards/${id}`, { name: $('#pg-name', m).value }); close(); loadPages(); }
      catch (e) { $('#pg-err', m).textContent = e.message; $('#pg-err', m).hidden = false; }
    };
    $('#pg-del', m).onclick = () => { close(); deletePageDialog(id); };
  });
}

function clearBoardDialog() {
  const captain = S.squad?.role === 'captain';
  const mine = D.strokes.filter(s => s.user_id === S.me?.id).length;
  const cur = D.pages.find(p => p.id === D.board);
  const page = cur?.name || 'this page';
  const isPrivate = cur?.scope === 'personal';
  modal('Clear the page', `
    <div class="set-why">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-info"/></svg>
      <p>${isPrivate
        ? `This removes <b>everything</b> on your private page <b>${esc(page)}</b>. Nobody else could see it anyway.`
        : captain
        ? `You are the captain, so this removes <b>everything</b> on <b>${esc(page)}</b> —
           all ${D.strokes.length} mark${D.strokes.length === 1 ? '' : 's'}, including other people's.`
        : `This removes <b>your ${mine} mark${mine === 1 ? '' : 's'}</b> on <b>${esc(page)}</b>.
           Everyone else keeps theirs.`}
        It cannot be undone.</p>
    </div>
    <p class="gate-error" id="cb-err" hidden></p>
    <div class="set-row"><button class="btn" data-cancel style="flex:1;justify-content:center">Keep it</button>
      <button class="btn btn-quiet-danger" id="cb-go" style="flex:1;justify-content:center">
        ${(captain || isPrivate) ? 'Clear everything' : 'Clear my marks'}</button></div>`,
  (m, close) => {
    $('[data-cancel]', m).onclick = close;
    $('#cb-go', m).onclick = async () => {
      $('#cb-go', m).disabled = true;
      try {
        await api('DELETE', `/api/squads/${S.squad.id}/board?board=${encodeURIComponent(D.board)}`);
        close(); D.loaded = null; await openBoard();
        toast('Cleared', page, 'ok');
      } catch (e) { $('#cb-err', m).textContent = e.message; $('#cb-err', m).hidden = false; $('#cb-go', m).disabled = false; }
    };
  });
}

function deletePageDialog(id) {
  const page = D.pages.find(p => p.id === id);
  if (!page) return;
  modal('Delete this page', `
    <div class="set-why">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-info"/></svg>
      <p>Deletes <b>${esc(page.name)}</b> and the ${page.marks} mark${page.marks === 1 ? '' : 's'} on it${
        page.scope === 'personal' ? '. This one was only ever visible to you' : ', for everyone in the squad'}.
        The other pages are untouched. <b>There is no undo</b> —
        save it as a picture first if you might want it.</p>
    </div>
    <p class="gate-error" id="dp-err" hidden></p>
    <div class="set-row">
      <button class="btn" data-cancel style="flex:1;justify-content:center">Keep the page</button>
      <button class="btn btn-quiet-danger" id="dp-go" style="flex:1;justify-content:center">Delete it</button></div>`,
  (m, close) => {
    $('[data-cancel]', m).onclick = close;
    $('#dp-go', m).onclick = async () => {
      $('#dp-go', m).disabled = true;
      try {
        await api('DELETE', `/api/boards/${id}`);
        close();
        if (D.board === id) D.board = null;
        D.loaded = null;
        await loadPages(); await openBoard();
        toast('Page deleted', page.name, 'ok');
      } catch (e) { $('#dp-err', m).textContent = e.message; $('#dp-err', m).hidden = false; $('#dp-go', m).disabled = false; }
    };
  });
}

async function openBoard() {
  if (!S.squad) return;
  if (!D.pages.length) await loadPages();
  $('#draw-colours').innerHTML = PENS.map(c =>
    `<button class="pen" data-pen="${c}" style="background:${c}" aria-label="Pen colour"
      ${c === D.colour ? 'aria-pressed="true"' : 'aria-pressed="false"'}></button>`).join('');
  $$('.pen').forEach(b => b.onclick = () => {
    D.colour = b.dataset.pen;
    $$('.pen').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  if (D.loaded !== S.squad.id + ':' + D.board) {
    try {
      const d = await api('GET', `/api/squads/${S.squad.id}/board${D.board ? '?board=' + encodeURIComponent(D.board) : ''}`);
      D.strokes = d.strokes;
      D.loaded = S.squad.id + ':' + D.board;
    } catch (e) { toast('Could not open the board', e.message); }
  }
  const pg = D.pages.find(p => p.id === D.board);
  if (pg) pg.marks = D.strokes.length;
  renderPages();
  paintNote();
  paintBoard();
}

function boardPoint(ev) {
  const cv = $('#draw-canvas'), r = cv.getBoundingClientRect();
  return [Math.round((ev.clientX - r.left) / r.width * W), Math.round((ev.clientY - r.top) / r.height * H)];
}

async function commitStroke(s) {
  D.strokes.push({ ...s, user_id: S.me?.id });
  paintBoard();
  const page = D.pages.find(p => p.id === D.board);
  if (page) { page.marks = D.strokes.length; renderPages(); }
  paintNote();
  try {
    const r = await api('POST', `/api/squads/${S.squad.id}/board`, { board: D.board, ...s });
    /* keep the server's id so undo and live removal line up */
    const local = D.strokes[D.strokes.length - 1];
    if (local && !local.id) local.id = r.stroke.id;
  } catch (e) { toast('Mark not saved', e.message); }
}

function initBoard() {
  const cv = $('#draw-canvas');
  if (!cv) return;
  let active = false;

  cv.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0 || !S.squad) return;
    const at = boardPoint(ev);
    if (D.tool === 'text') { startTyping(at, ev); return; }
    active = true;
    cv.setPointerCapture?.(ev.pointerId);
    D.drawing = { kind: D.tool, colour: D.colour, width: Number($('#draw-width').value) || 3,
                  fill: D.tool === 'rect' || D.tool === 'ellipse' ? ($('#draw-fill').checked ? 1 : 0) : 0,
                  points: [at, at] };
  });

  cv.addEventListener('pointermove', (ev) => {
    if (!active || !D.drawing) return;
    const p = boardPoint(ev);
    if (D.drawing.kind === 'pen') {
      const last = D.drawing.points[D.drawing.points.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 3) return;
      D.drawing.points.push(p);
      if (D.drawing.points.length > 560) return finish();
    } else {
      D.drawing.points[1] = p;    /* a shape is only ever its two corners */
    }
    paintBoard();
  });

  const finish = () => {
    if (!active) return;
    active = false;
    const s = D.drawing;
    D.drawing = null;
    if (!s) { paintBoard(); return; }
    const [a, b] = [s.points[0], s.points[s.points.length - 1]];
    const tiny = s.kind !== 'pen' && Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) < 6;
    if (tiny || (s.kind === 'pen' && s.points.length < 2)) { paintBoard(); return; }
    commitStroke(s);
  };
  addEventListener('pointerup', finish);
  cv.addEventListener('pointerleave', () => { if (active) finish(); });
  addEventListener('resize', () => { if (S.view === 'draw') paintBoard(); });

  $$('.tool').forEach(b => b.onclick = () => {
    D.tool = b.dataset.tool;
    $$('.tool').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    $('#draw-text-opts').hidden = D.tool !== 'text';
    $('#draw-fill').closest('.draw-fill').hidden = !['rect', 'ellipse'].includes(D.tool);
  });
  $('#draw-fill').closest('.draw-fill').hidden = true;
  addEventListener('keydown', (e) => {
    if (S.view !== 'draw' || e.metaKey || e.ctrlKey || /input|textarea/i.test(e.target.tagName)) return;
    const map = { p: 'pen', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text' };
    const want = map[e.key.toLowerCase()];
    if (want) { $(`.tool[data-tool="${want}"]`)?.click(); }
  });

  $('#draw-undo').onclick = async () => {
    try {
      const r = await api('POST', `/api/squads/${S.squad.id}/board/undo`, { board: D.board });
      if (!r.removed) return toast('Nothing to undo', 'You have not drawn on this page.');
      D.strokes = D.strokes.filter(x => x.id !== r.removed);
      paintBoard();
      const pg = D.pages.find(p => p.id === D.board);
      if (pg) { pg.marks = D.strokes.length; renderPages(); }
      paintNote();
    } catch (e) { toast('Could not undo', e.message); }
  };
  $('#draw-clear').onclick = clearBoardDialog;
  $('#draw-save').onclick = savePng;
  $('#draw-send').onclick = sendBoardDialog;
}
initBoard();

/* Typing happens in a transparent textarea sitting exactly where the label
   will land, so what you see while typing is what the board keeps — a prompt
   box told you nothing about size, colour or position. */
function startTyping(at, ev) {
  const ta = $('#draw-typing'), cv = $('#draw-canvas');
  const r = cv.getBoundingClientRect(), wrap = $('#draw-wrap').getBoundingClientRect();
  const size = Number($('#draw-size').value) || 32;
  const scale = r.width / W;

  ta.value = '';
  ta.hidden = false;
  ta.style.left = (r.left - wrap.left + at[0] * scale) + 'px';
  ta.style.top = (r.top - wrap.top + at[1] * scale) + 'px';
  ta.style.font = `${size * scale}px ${FONT_STACK[$('#draw-font').value] || FONT_STACK.sans}`;
  ta.style.color = D.colour;
  ta.style.maxWidth = (r.right - (r.left + at[0] * scale) - 6) + 'px';
  const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  grow();
  setTimeout(() => ta.focus(), 0);

  const done = (save) => {
    ta.hidden = true;
    ta.oninput = ta.onkeydown = ta.onblur = null;
    const text = ta.value.replace(/\s+$/, '');
    if (save && text) commitStroke({
      kind: 'text', points: [at], text: text.slice(0, 400),
      colour: D.colour, width: Number($('#draw-width').value) || 3,
      font: $('#draw-font').value, size
    });
  };
  ta.oninput = grow;
  ta.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
    /* Enter commits, Shift+Enter makes another line — the same as the composer */
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
  };
  ta.onblur = () => done(true);
}

/* ---- export ---- */
function boardCanvas(scale = 2) {
  const cv = document.createElement('canvas');
  cv.width = W * scale / 2; cv.height = H * scale / 2;
  paintBoard(cv, true);
  return cv;
}
const pageName = () => (D.pages.find(p => p.id === D.board)?.name || 'board').replace(/[^\w -]/g, '');

function savePng() {
  if (!D.strokes.length) return toast('Nothing to save', 'Draw something first.');
  boardCanvas(2).toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = el('a', '');
    a.href = url;
    a.download = `${(S.squad?.name || 'squadron').replace(/[^\w -]/g, '')} — ${pageName()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Saved', 'Check your downloads folder.', 'ok');
  }, 'image/png');
}

/* shared plumbing: turn the page into a stored picture the server can serve */
function uploadBoardPng() {
  return new Promise((resolve) => {
    if (!D.strokes.length) { toast('Nothing to send', 'Draw something first.'); return resolve(null); }
    const cv = boardCanvas(2);
    cv.toBlob(async (blob) => {
      try {
        const data = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1] || '');
          r.onerror = rej;
          r.readAsDataURL(blob);
        });
        resolve(await api('POST', '/api/images', { data, mime: 'image/png', w: cv.width, h: cv.height }));
      } catch (e) { toast('Could not prepare the picture', e.message); resolve(null); }
    }, 'image/png');
  });
}

function sendBoardDialog() {
  if (!S.squad) return;
  const mates = (S.dmPeople || []);
  modal('Send this page', `
    <div class="fld"><label for="sb-where">Where</label>
      <select id="sb-where">
        <optgroup label="Channel">${S.squad.channels.map(c => `<option value="ch:${c.id}">${esc(c.icon || '#')} ${esc(c.name)}</option>`).join('')}</optgroup>
        ${mates.length ? `<optgroup label="Direct">${mates.map(p => `<option value="dm:${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>` : ''}
      </select></div>
    <div class="fld"><label for="sb-note">Say something <span class="wz-opt">optional</span></label>
      <input id="sb-note" type="text" maxlength="300" value="${esc(pageName())}"></div>
    <p class="fld-help">The page is sent as a picture, so it stays readable even after the board changes.</p>
    <p class="gate-error" id="sb-err" hidden></p>
    <button class="btn btn-primary btn-lg" id="sb-go" style="width:100%;justify-content:center">Send</button>`,
  (m, close) => {
    $('#sb-go', m).onclick = async () => {
      const go = $('#sb-go', m); go.disabled = true; go.textContent = 'Preparing…';
      try {
        const img = await uploadBoardPng();
        if (!img) { go.disabled = false; go.textContent = 'Send'; return; }
        const [kind, id] = $('#sb-where', m).value.split(':');
        const note = $('#sb-note', m).value;
        if (kind === 'ch') {
          await api('POST', `/api/channels/${id}/image`, { imageId: img.id, body: note });
          close(); toast('Sent', 'Posted in the channel.', 'ok');
        } else {
          const { thread } = await api('POST', '/api/dms', { userId: id });
          await api('POST', `/api/dms/${thread.id}/messages`, { body: note, imageId: img.id });
          close(); await loadDmList(); toast('Sent', 'Posted in your conversation.', 'ok');
        }
      } catch (e) { $('#sb-err', m).textContent = e.message; $('#sb-err', m).hidden = false; $('#sb-go', m).disabled = false; $('#sb-go', m).textContent = 'Send'; }
    };
  });
}

/* live marks from the rest of the squad */
function onStroke(msg) {
  if (msg.stroke.user_id === S.me?.id) return;
  if (msg.board !== D.board) return;
  D.strokes.push(msg.stroke);
  if (S.view === 'draw') { paintBoard(); paintNote(); }
}
function onBoardCleared(msg) {
  if (msg.board !== D.board) return;
  D.loaded = null;
  if (S.view === 'draw') openBoard();
}

/* ---------------------------------------------------- schedule import */
$('#import-schedule').onclick = () => {
  if (!S.squad) return;
  modal('Import a contest schedule', `
    <div class="set-why">
      <svg class="icon icon-sm" aria-hidden="true"><use href="#i-cal"/></svg>
      <p>Paste an <b>.ics</b> file from a judge's calendar, or type one contest per line as
         <code>2026-04-02 19:30 Round name</code>. Nothing is fetched from anywhere —
         what you paste is all that is read.</p>
    </div>
    <div class="fld"><label for="imp-text">Paste here</label>
      <textarea id="imp-text" rows="7" spellcheck="false" placeholder="BEGIN:VCALENDAR&#10;…&#10;&#10;or&#10;&#10;2026-04-02 19:30 Mock contest A"></textarea></div>
    <div class="pin-list" id="imp-preview"></div>
    <p class="gate-error" id="imp-err" hidden></p>
    <button class="btn btn-primary btn-lg" id="imp-go" style="width:100%;justify-content:center" disabled>Import</button>`,
  (m, close) => {
    const ta = $('#imp-text', m), go = $('#imp-go', m);
    let found = [], timer;
    ta.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!ta.value.trim()) { $('#imp-preview', m).innerHTML = ''; go.disabled = true; return; }
        try {
          const d = await api('POST', `/api/squads/${S.squad.id}/schedule/preview`, { text: ta.value });
          found = d.found;
          go.disabled = !found.length;
          go.textContent = found.length ? `Import ${found.length} event${found.length === 1 ? '' : 's'}` : 'Import';
          $('#imp-preview', m).innerHTML = found.length
            ? found.map(f => `<div class="pin-i"><span class="pin-a mono">${new Date(f.startsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${f.minutes} min</span>
                <span class="pin-b">${esc(f.title)}</span></div>`).join('')
            : '<p class="fld-help">Nothing recognisable yet.</p>';
        } catch (e) { $('#imp-err', m).textContent = e.message; $('#imp-err', m).hidden = false; }
      }, 350);
    };
    go.onclick = async () => {
      go.disabled = true;
      try {
        const r = await api('POST', `/api/squads/${S.squad.id}/schedule/import`, { text: ta.value });
        close();
        toast('Schedule imported', `${r.added} added${r.skipped ? `, ${r.skipped} already there` : ''}`, 'ok');
        const bundle = await api('GET', `/api/squads/${S.squad.id}`);
        S.events = bundle.events; renderCalendar();
      } catch (e) { $('#imp-err', m).textContent = e.message; $('#imp-err', m).hidden = false; go.disabled = false; }
    };
  });
};

/* An invitation you cannot act on is just a notification. This is the accept
   or decline, and it opens itself when one is waiting. */
function showInvitesDialog() {
  const list = S.invites || [];
  if (!list.length) return;
  modal(list.length === 1 ? 'You have an invitation' : `You have ${list.length} invitations`, `
    <div class="pin-list" id="iv-list">${list.map(i => `
      <div class="iv-row" data-iv="${i.id}">
        <span class="av av-m" style="background:${tint(i.id)}">${esc(initials(i.squad_name))}</span>
        <span class="iv-b"><span class="iv-n">${esc(i.squad_name)}</span>
          <span class="iv-s mono">${esc(KINDS[i.kind]?.label || i.kind)}${i.role === 'advisor' ? ' · as advisor' : ''}</span></span>
        <span class="iv-acts">
          <button class="btn btn-sm" data-decline="${i.id}">Decline</button>
          <button class="btn btn-primary btn-sm" data-accept="${i.id}">Join</button></span>
      </div>`).join('')}</div>
    <p class="gate-error" id="iv-err" hidden></p>`,
  (m, close) => {
    const done = (id) => {
      S.invites = S.invites.filter(x => x.id !== id);
      $(`.iv-row[data-iv="${id}"]`, m)?.remove();
      if (!S.invites.length) close();
    };
    $('#iv-list', m).addEventListener('click', async (ev) => {
      const acc = ev.target.closest('[data-accept]'), dec = ev.target.closest('[data-decline]');
      const btn = acc || dec;
      if (!btn) return;
      btn.disabled = true;
      const id = acc ? acc.dataset.accept : dec.dataset.decline;
      try {
        if (acc) {
          const { squad } = await api('POST', `/api/invites/${id}/accept`);
          done(id);
          await loadSquads();
          await openSquad(squad.id);
          toast(`You are in ${squad.name}`, 'Say hello in #general', 'ok');
        } else {
          await api('POST', `/api/invites/${id}/decline`);
          done(id);
        }
      } catch (e) { $('#iv-err', m).textContent = e.message; $('#iv-err', m).hidden = false; btn.disabled = false; }
    });
  });
}

/* ------------------------------------------------------------ the tour */
/* Spotlights the real interface in place rather than describing it in a
   modal. Steps whose target is not on screen at this width are dropped, so
   the same script works on a laptop and a phone. */
const TOUR = [
  { sel: '.sw-wrap', side: 'right', k: 'Squads',
    t: 'Every squad you are in', b: 'Switch between your ICPC team, a GSoC circle, a hackathon crew — or start a new one. Switching changes <b>everything</b> below: channels, board, standings.' },
  { sel: '#side-scroll', side: 'right', k: 'This squad',
    t: 'Channels and work', b: 'Text channels carry the discussion; the board, calendar and standings carry the work. Press <b>+</b> beside <b>Text</b> to add a channel and give it any symbol you like.' },
  { sel: '.tabs', side: 'bottom', k: 'Views',
    t: 'The same squad, four ways', b: 'Chat, task board, calendar and standings. Only the active tab shows its label, so the bar stays out of the way.' },
  { sel: '#pal-open', side: 'bottom', k: 'Search',
    t: 'Jump to anything', b: 'Press <b>⌘K</b> (Ctrl+K) to search channels, tasks, teammates and actions at once — the fastest way around.' },
  { sel: '#composer', side: 'top', k: 'Messages',
    t: 'Type, or hold the mic', b: 'Enter sends, Shift+Enter makes a new line. The <b>microphone</b> records a voice note instead — useful when explaining a bug is faster out loud.' },
  { sel: '[data-code-open]', view: null, side: 'right', k: 'Compiler',
    t: 'C++ and Python, in the workspace', b: '<b>Personal</b> files are yours alone. <b>Team</b> files are visible to the whole squad and sync live as anyone types. Run them right here and share the result into a channel.' },
  { sel: '#v-board [data-drop="Solved"]', view: 'board', side: 'left', k: 'Task board',
    t: 'Solved is where XP pays out', b: 'Drag a card in and the XP lands immediately — on you and on the standings. Drag it back out and the XP is withdrawn.' },
  { sel: '#v-xp .lvl', view: 'xp', side: 'bottom', k: 'XP',
    t: 'Earned, not farmed', b: 'XP comes from work that actually landed: tasks moved to Solved, not time spent in the app.' },
  { sel: '#v-cal .cal-main', view: 'cal', side: 'right', k: 'Calendar',
    t: 'Deadlines and meetings', b: 'Task due dates, rounds, and any meeting the squad schedules. Starting a meeting from here puts a video room in the calendar.' },
  { sel: '#ctx', view: 'chat', side: 'left', k: 'Squad panel',
    t: 'Who is here, what is next', b: 'Roster, open seats and the squad at a glance.' }
];

let coBlock = null, coHole = null, coCard = null, coStep = 0, coSteps = [];

/* A drawer that is translated off-screen still reports a full-size rect, so
   size alone is not enough — the target has to actually intersect the viewport
   or the spotlight lands on nothing. */
/* A tour that stays inside the compiler. The workspace tour has to close the
   compiler to point at anything, so these steps carry `inCode` and the engine
   leaves it open. Written because the one thing nobody finds on their own is
   where the input goes — a collapsed row between the buttons and the output. */
const CODE_TOUR = [
  { sel: '.code-scopes', inCode: true, side: 'bottom', k: 'Whose file',
    t: 'Personal or Team', b: '<b>Personal</b> files are yours alone. <b>Team</b> files are visible to the whole squad and sync live as anyone types — useful for a shared template.' },
  { sel: '#code-lang', inCode: true, side: 'bottom', k: 'Language',
    t: 'C++ or Python', b: 'Set this to match the code you are writing. It decides which compiler runs and how the file is highlighted — the chip on the file tab shows the current setting.' },
  { sel: '.code-editor', inCode: true, side: 'bottom', k: 'Editor',
    t: 'Write it here', b: 'Saves as you type, so there is nothing to press. <b>Tab</b> indents, and the squad sees changes to a Team file straight away.' },
  { sel: '#code-cases', inCode: true, side: 'top', k: 'Test cases',
    t: 'Many inputs at once', b: 'Save an input and the answer you expect, then <b>Run tests</b> checks them all in one go — the fastest way to know a solution holds.' },
  { sel: '#code-go', inCode: true, side: 'top', k: 'Run',
    t: 'Compile and run', b: 'The program runs in a sandbox with no network access and a few seconds of CPU, so an infinite loop stops itself rather than taking the server with it.' },
  { sel: '#code-out', inCode: true, side: 'top', k: 'Output',
    t: 'Output, and where you answer', b: 'The program prints here as it goes. When it asks a question a line opens underneath — type the answer and press Enter, or paste a whole case and every line is fed in order. Your answer is echoed here <b class="co-in-eg">in gold</b>, the way a terminal shows it — so a program that reads a number and then prints it shows that number twice: once because you typed it, once because it printed it. A crash is explained in words rather than left as a bare number.' },
  { sel: '#code-split', inCode: true, side: 'top', k: 'Layout',
    t: 'Drag to resize', b: 'Pull this bar to give more room to the editor or to the output. Arrow keys work too, and a double-click puts it back.' }
];

const coVisible = (sel) => {
  const e = $(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  if (r.width <= 8 || r.height <= 8) return null;
  const onScreen = r.right > 4 && r.bottom > 4 && r.left < innerWidth - 4 && r.top < innerHeight - 4;
  return onScreen ? e : null;
};

/* below 1024px the sidebar is a drawer; steps that point into it need it open */
const IN_SIDEBAR = ['.sw-wrap', '#side-scroll', '[data-code-open]'];
const drawerNeeded = (sel) => IN_SIDEBAR.includes(sel) && innerWidth <= 1023;

function coPlace() {
  const st = coSteps[coStep];
  const e = coVisible(st.sel);
  if (!e) return coNext();
  const r = e.getBoundingClientRect(), pad = 6;
  Object.assign(coHole.style, {
    top: (r.top - pad) + 'px', left: (r.left - pad) + 'px',
    width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px'
  });
  /* restart the pulse so a jump reads as a jump */
  [coHole, coCard].forEach(n => { n.removeAttribute('data-moved'); void n.offsetHeight; n.dataset.moved = '1'; });

  $('.co-k', coCard).textContent = st.k;
  $('.co-t', coCard).textContent = st.t;
  $('.co-b', coCard).innerHTML = st.b;
  $$('.co-dot', coCard).forEach((d, i) => d.dataset.on = String(i === coStep));
  $('.co-next', coCard).textContent = coStep === coSteps.length - 1 ? 'Finish' : 'Next';
  $('.co-back', coCard).disabled = coStep === 0;

  const cw = coCard.offsetWidth, ch = coCard.offsetHeight, gap = 14;
  let left, top;
  if (st.side === 'right')     { left = r.right + gap; top = r.top; }
  else if (st.side === 'left') { left = r.left - cw - gap; top = r.top; }
  else if (st.side === 'top')  { left = r.left; top = r.top - ch - gap; }
  else                         { left = r.left; top = r.bottom + gap; }
  left = Math.max(12, Math.min(left, innerWidth - cw - 12));
  if (top + ch > innerHeight - 12) top = Math.max(12, r.top - ch - gap);
  coCard.style.left = left + 'px';
  coCard.style.top = Math.max(12, top) + 'px';
}

function coGo(i) {
  coStep = Math.max(0, Math.min(coSteps.length - 1, i));
  const st = coSteps[coStep];
  /* the compiler owns the whole content area, so it must be shut before a
     step that points at something underneath it */
  if (st.inCode || st.sel === '[data-code-open]') { if (!C.open) openCode(); }
  else if (C.open) closeCode();
  if (drawerNeeded(st.sel)) { $('#side').dataset.open = '1'; $('#scrim').hidden = false; }
  else if (innerWidth <= 1023) closeDrawer();
  if (st.view) setView(st.view);
  const wait = (st.view || st.inCode || st.sel === '[data-code-open]' || drawerNeeded(st.sel)) ? 320 : 0;
  setTimeout(coPlace, wait);
}
function coNext() { coStep >= coSteps.length - 1 ? coEnd() : coGo(coStep + 1); }

function coEnd() {
  const wasInCode = coSteps.some(s => s.inCode);
  if (coBlock) { coBlock.remove(); coHole.remove(); coCard.remove(); coBlock = coHole = coCard = null; }
  document.removeEventListener('keydown', coKeys);
  removeEventListener('resize', coPlace);
  /* leave the compiler where the tour was describing it, rather than closing
     the thing the person has just been taught to use */
  if (C.open && !wasInCode) closeCode();
  if (innerWidth <= 1023) closeDrawer();
  toast(wasInCode ? 'That is the compiler' : 'Tour finished',
    wasInCode ? 'Reopen this walk-through from the ⓘ at the top right.' : 'Press ⌘K any time to jump anywhere.', 'ok');
}
function coKeys(e) {
  if (e.key === 'Escape') { e.preventDefault(); coEnd(); }
  else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); coNext(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); coGo(coStep - 1); }
}

/* the spotlight, the card and its wiring — shared by both tours */
function coBuild() {
  coBlock = el('div', 'co-block');
  coHole = el('div', 'co-hole'); coHole.setAttribute('aria-hidden', 'true');
  coCard = el('div', 'co-card',
    `<span class="eyebrow co-k"></span><h3 class="co-t"></h3><p class="co-b"></p>
     <div class="co-row"><span class="co-dots">${coSteps.map(() => '<span class="co-dot"></span>').join('')}</span>
     <button class="co-skip">Skip</button>
     <button class="btn btn-sm co-back">Back</button>
     <button class="btn btn-primary btn-sm co-next">Next</button></div>`);
  coCard.setAttribute('role', 'dialog');
  coCard.setAttribute('aria-modal', 'true');
  coCard.setAttribute('aria-label', 'Guided tour');
  document.body.append(coBlock, coHole, coCard);

  $('.co-next', coCard).onclick = coNext;
  $('.co-back', coCard).onclick = () => coGo(coStep - 1);
  $('.co-skip', coCard).onclick = coEnd;
  coBlock.onclick = coEnd;
  document.addEventListener('keydown', coKeys);
  addEventListener('resize', coPlace);
}

/* the compiler's own walk-through, launched from the ⓘ in its header */
function startCodeTour() {
  if (coBlock) coEnd();
  if (!C.open) openCode();
  setTimeout(() => {
    coSteps = CODE_TOUR.filter(st => coVisible(st.sel));
    if (!coSteps.length) return toast('Open a file first', 'The walk-through points at a file you are editing.');
    coBuild();
    coGo(0);
  }, C.open ? 60 : 420);
}
$('#code-help').onclick = startCodeTour;

function startTour() {
  if (coBlock) coEnd();                       /* never stack two tours */
  /* A `view` step switches tabs to bring its target into being. That only works
     if there is a squad behind those tabs — without one the tour would point at
     empty space and read as broken. So with no squad, keep only what is
     genuinely on screen: the switcher, the sidebar, the tabs and search. */
  coSteps = S.squad
    ? TOUR.filter(st => st.view || st.sel === '[data-code-open]' || drawerNeeded(st.sel) || coVisible(st.sel))
    : TOUR.filter(st => drawerNeeded(st.sel) || coVisible(st.sel));
  if (!coSteps.length) return;

  coBuild();

  coGo(0);
  setTimeout(() => $('.co-next', coCard)?.focus(), 80);
}

/* offered once per account — the flag lives on the user, not in this browser */
function markTourSeen() {
  $('#tour-ask').hidden = $('#tour-ask-scrim').hidden = true;
  if (S.me && !S.me.tourSeen) {
    S.me.tourSeen = true;
    api('POST', '/api/me/tour-seen').catch(() => {});
  }
}
/* called after boot and again after the first squad exists */
function maybeOfferTour() {
  /* No squad requirement. Someone signing in for the very first time is exactly
     who the tour is for, and gating it on a squad meant they only ever met it
     later — after joining one — by which point they had already worked the
     place out. startTour drops the steps that need a squad. */
  if (!S.me || S.me.tourSeen) return;
  setTimeout(offerTour, 900);
}
function offerTour() {
  if (!S.me || S.me.tourSeen || !$('#tour-ask').hidden) return;
  $('#tour-ask').hidden = $('#tour-ask-scrim').hidden = false;
  setTimeout(() => $('#tour-yes').focus(), 60);
}
$('#tour-yes').onclick = () => { markTourSeen(); startTour(); };
$('#tour-no').onclick = () => { markTourSeen(); toast('Tour skipped', 'Reopen it any time from ⌘K.'); };
$('#tour-ask-scrim').onclick = markTourSeen;
window.Squadron = window.Squadron || {};
window.Squadron.startTour = startTour;

/* ---------------------------------------------------------- websocket */
function openSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => { if (S.squad) ws.send(JSON.stringify({ type: 'watch', squadId: S.squad.id })); };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type.startsWith('meeting') || ['offer', 'answer', 'ice'].includes(msg.type)) return handleSignal(msg);
    if (msg.type === 'message') {
      if (msg.mentioned?.includes(S.me?.id)) {
        loadMentions();
        toast('You were mentioned', `${msg.message.author.name} in #${S.squad?.channels.find(c => c.id === msg.channelId)?.name || ''}`, 'ok');
      }
      TYPERS.delete(msg.message.author.name); paintTyping();
      if (msg.message.parentId) { countReply(msg.message); refreshThread(); return; }
      if (msg.channelId === S.channel?.id) { upsertMessage(msg.message); markChannelRead(S.channel); return; }
      /* somewhere else in this squad — raise the badge on that channel */
      const c = S.squad?.channels.find(x => x.id === msg.channelId);
      if (c && msg.message.author.id !== S.me?.id) { c.unread = (c.unread || 0) + 1; renderChannels(); }
      return;
    }
    if (msg.type === 'dm') {
      if (DM.thread && msg.threadId === DM.thread.id) {
        const i = DM.messages.findIndex(x => x.id === msg.message.id);
        if (i > -1) DM.messages[i] = msg.message; else DM.messages.push(msg.message);
        renderDm();
        if (msg.message.author.id !== S.me?.id) api('POST', `/api/dms/${msg.threadId}/read`).catch(() => {});
      } else if (msg.message.author.id !== S.me?.id) {
        toast('Message from ' + msg.message.author.name, (msg.message.body || 'sent a picture').slice(0, 70));
      }
      loadDmList();
      return;
    }
    if (msg.type === 'dm-read') {
      if (DM.thread && msg.threadId === DM.thread.id && msg.userId !== S.me?.id) { DM.theirRead = msg.readAt; renderDm(); }
      return;
    }
    if (msg.type === 'dm-deleted') {
      if (DM.thread && msg.threadId === DM.thread.id) {
        const i = DM.messages.findIndex(x => x.id === msg.id);
        if (i > -1) { DM.messages[i] = { ...DM.messages[i], deleted: true, body: '', image: null }; renderDm(); }
      }
      loadDmList();
      return;
    }
    if (msg.type === 'boards') { if (S.view === 'draw') loadPages(); return; }
    if (msg.type === 'stroke-removed') {
      D.strokes = D.strokes.filter(x => x.id !== msg.id);
      if (S.view === 'draw') paintBoard();
      return;
    }
    if (msg.type === 'typing') {
      if (msg.channelId === S.channel?.id) showTyping(msg.user);
      return;
    }
    if (msg.type === 'message-edited') {
      if (msg.channelId === S.channel?.id) upsertMessage(msg.message);
      refreshThread();
      return;
    }
    if (msg.type === 'message-deleted') {
      const i = S.messages.findIndex(x => x.id === msg.id);
      if (i > -1) { S.messages[i] = { ...S.messages[i], deleted: true, body: '', kind: 'deleted', reactions: [], reacted: [] }; renderMessages(); }
      refreshThread();
      return;
    }
    if (msg.type === 'pins') { if (msg.channelId === S.channel?.id) loadPins(); return; }
    if (msg.type === 'stroke') { onStroke?.(msg); return; }
    if (msg.type === 'board-cleared') { onBoardCleared?.(msg); return; }
    if (msg.type === 'squad-left') { if (msg.userId !== S.me?.id) toast(msg.name + ' left the squad', ''); return; }
    if (msg.type === 'read') {
      if (msg.channelId === S.channel?.id) {
        S.reads[msg.userId] = msg.readAt;
        renderMessages();
      }
      return;
    }
    if (msg.type === 'snippet') {
      if (msg.snippet.squadId === S.squad?.id) upsertSnippet(msg.snippet);
      return;
    }
    if (msg.type === 'snippet-removed') { dropSnippet(msg.id); return; }
    if (msg.type === 'code-out')     { onCodeOut(msg); return; }
    if (msg.type === 'code-end')     { onCodeEnd(msg); return; }
    if (msg.type === 'code-started') { return; }
    if (msg.type === 'invited') {
      /* The list was being refreshed without anything being redrawn, so the
         invitation only appeared after a reload — which is not an invitation
         arriving, it is an invitation being found later. */
      api('GET', '/api/me').then(d => {
        S.invites = d.pendingInvites || [];
        renderSquadList();
        toast(`${msg.from} invited you to ${msg.squadName}`,
          'It is in the squad switcher, top left — tap it to join.', 'ok');
      }).catch(() => {
        toast(`${msg.from} invited you to ${msg.squadName}`, 'Reload to see it.', 'ok');
      });
      return;
    }
    if (msg.type === 'channel-removed') {
      if (msg.squadId !== S.squad?.id) return;
      S.squad.channels = S.squad.channels.filter(c => c.id !== msg.id);
      if (S.channel?.id === msg.id) {
        /* do not leave someone reading a channel that no longer exists */
        S.channel = S.squad.channels[0] || null;
        if (S.channel) { renderChannels(); loadMessages(S.channel.id); setView('chat'); }
        toast('#' + msg.name + ' was deleted', 'The captain removed it.');
      }
      renderChannels();
      return;
    }
    if (msg.type === 'channel') {
      if (msg.squadId === S.squad?.id) upsertChannel(msg.channel);
      return;
    }
    if (msg.type === 'reaction') {
      const m = S.messages.find(x => x.id === msg.messageId);
      if (m) { m.reactions = msg.reactions; renderMessages(); }
      return;
    }
    if (msg.type === 'task') { upsertTask(msg.task); return; }
    if (msg.type === 'task-removed') { S.tasks = S.tasks.filter(t => t.id !== msg.id); renderBoard(); return; }
    if (msg.type === 'event') { upsertEvent(msg.event); return; }
    if (msg.type === 'squad') { applySquad(msg.squad); return; }
    if (msg.type === 'event-removed') { S.events = S.events.filter(e => e.id !== msg.id); renderCalendar(); return; }
  };
  ws.onclose = () => setTimeout(() => { if (S.me) openSocket(); }, 2000);
}

/* ---------------------------------------------------------- squad wizard */
const KINDS = {
  icpc:  { label: 'ICPC team', cap: 3, blurb: 'A small roster, a shared template file you can run, and a regional to aim at.' },
  gsoc:  { label: 'GSoC circle', cap: 6, blurb: 'Read each other’s proposals before anyone submits one.' },
  hack:  { label: 'Hackathon squad', cap: 6, blurb: 'Thirty-six hours, a locked problem statement, one demo.' },
  study: { label: 'Study group', cap: 12, blurb: 'A rated ladder, one problem a day, at a fixed hour.' }
};
function squadWizard() {
  let kind = null, emails = [];
  modal('Start a squad', `
    <p class="modal-sub">The competition sets the team size and which channels you get.</p>
    <div class="wz-kinds" id="w-kinds" role="radiogroup" aria-label="Competition">
      ${Object.entries(KINDS).map(([k, v]) => `<button class="wz-kind" role="radio" aria-checked="false" data-k="${k}">
        <b>${v.label}</b><span>${v.blurb}</span><em>up to ${v.cap} people</em></button>`).join('')}
    </div>
    <div class="fld"><label for="w-name">Squad name</label><input id="w-name" type="text"></div>
    <div class="fld"><label for="w-tag">One line about it <span class="wz-opt">optional</span></label><input id="w-tag" type="text"></div>
    <div class="fld"><label for="w-cap">How many people can join</label>
      <input id="w-cap" type="number" min="2" max="200" value="6">
      <p class="fld-help" id="w-caphint">You can change this at any time.</p></div>
    <p class="gate-error" id="w-err" hidden></p>
    <button class="btn btn-primary btn-lg" id="w-go" style="width:100%;justify-content:center" disabled>Create squad</button>`,
  (m, close) => {
    const sync = () => { $('#w-go', m).disabled = !(kind && $('#w-name', m).value.trim()); };
    $$('.wz-kind', m).forEach(b => b.onclick = () => {
      kind = b.dataset.k;
      $$('.wz-kind', m).forEach(x => x.setAttribute('aria-checked', String(x === b)));
      $('#w-cap', m).value = KINDS[kind].cap;
      $('#w-caphint', m).textContent = `${KINDS[kind].label}s usually run at ${KINDS[kind].cap}. This is only a starting point — change it whenever.`;
      sync();
    });
    $('#w-name', m).oninput = sync;
    $('#w-go', m).onclick = async () => {
      try {
        const { squad } = await api('POST', '/api/squads', {
          name: $('#w-name', m).value, kind, tagline: $('#w-tag', m).value,
          cap: Number($('#w-cap', m).value) || KINDS[kind].cap
        });
        close();
        await loadSquads();
        await openSquad(squad.id);
        toast(`${squad.name} is live`, 'Use Invite in the roster panel to get a link you can share.', 'ok');
        inviteDialog();
      } catch (e) { $('#w-err', m).textContent = e.message; $('#w-err', m).hidden = false; }
    };
  });
}
$('#new-squad').onclick = () => { closeSw(); squadWizard(); };

/* ---------------------------------------------------------- chrome */
function setView(name) {
  /* the compiler covers the whole content area, so picking a view has to give
     the screen back — otherwise the tab changes behind a panel you can't see past */
  if (C.open) closeCode();
  S.view = name;
  ['chat', 'board', 'cal', 'xp', 'draw', 'dm'].forEach(v => { $('#v-' + v).hidden = v !== name; });
  $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === name)));
  const titles = { chat: S.channel?.name || 'Chat', board: 'Task board', cal: 'Calendar', xp: 'Standings & XP', draw: 'Whiteboard', dm: DM.other?.name || 'Direct' };
  const icons = { board: 'i-board', cal: 'i-cal', xp: 'i-trophy', draw: 'i-move', dm: 'i-chat' };
  /* the chat header wears the channel's own symbol; the other views keep their sprite */
  const mark = name === 'chat'
    ? `<span class="top-sym" id="top-sym" aria-hidden="true">${esc(channelSym(S.channel))}</span>`
    : `<svg class="icon" aria-hidden="true"><use href="#${icons[name]}"/></svg>`;
  $('#top-title').innerHTML = `${mark}<span>${esc(titles[name])}</span>`;
  $('#m-title').textContent = (name === 'chat' ? channelSym(S.channel) + ' ' : '') + titles[name];
  $('#top-note').textContent = S.squad ? `${S.squad.name} · ${S.squad.kindLabel}` : '';
  if (name === 'cal') renderCalendar();
  if (name === 'draw') openBoard();
  if (name === 'chat') $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
}
$$('.tab').forEach(t => t.onclick = () => setView(t.dataset.view));

const sw = $('#sw'), swMenu = $('#sw-menu');
const closeSw = () => { swMenu.hidden = true; sw.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', swOut, true); };
const swOut = (e) => { if (!$('.sw-wrap').contains(e.target)) closeSw(); };
sw.onclick = () => {
  if (swMenu.hidden) { swMenu.hidden = false; sw.setAttribute('aria-expanded', 'true'); setTimeout(() => document.addEventListener('pointerdown', swOut, true), 0); }
  else closeSw();
};

const closeDrawer = () => { $('#side').removeAttribute('data-open'); $('#scrim').hidden = true; };
$('#m-menu').onclick = () => { $('#side').dataset.open = '1'; $('#scrim').hidden = false; };
$('#scrim').onclick = closeDrawer;

$('#ctx-toggle').onclick = () => {
  const on = $('#ctx-toggle').getAttribute('aria-pressed') !== 'true';
  document.body.dataset.ctx = on ? 'on' : 'off';
  $('#ctx-toggle').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('sq.ctx', on ? '1' : '0'); } catch {}
};
(() => { let v = '1'; try { v = localStorage.getItem('sq.ctx') || '1'; } catch {} 
  document.body.dataset.ctx = v === '0' ? 'off' : 'on';
  $('#ctx-toggle').setAttribute('aria-pressed', String(v !== '0')); })();

if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
  $('#pal-kbd').textContent = 'Ctrl K';
  $('#side-kbd').textContent = 'Ctrl K';
}
const openPalette = () => {
  const items = [
    ...S.squad?.channels.map(c => ({ g: 'Channels', t: '#' + c.name, run: () => { S.channel = c; loadMessages(c.id); setView('chat'); renderChannels(); } })) || [],
    ...S.tasks.map(t => ({ g: 'Tasks', t: t.title, m: t.col, run: () => setView('board') })),
    ...S.squads.map(s => ({ g: 'Squads', t: s.name, run: () => openSquad(s.id) })),
    { g: 'Actions', t: 'Start a squad', run: squadWizard },
    { g: 'Actions', t: 'Schedule a meeting', run: () => meetingDialog(dayKey(Date.now())) },
    { g: 'Actions', t: 'New task', run: () => taskDialog('Backlog') },
    { g: 'Actions', t: 'Take the tour', run: () => setTimeout(startTour, 220) },
    { g: 'Actions', t: 'Add people to this squad', m: 'search by name', run: () => setTimeout(inviteDialog, 220) },
    { g: 'Actions', t: 'Message someone', run: () => setTimeout(newDmDialog, 220) }
  ];
  modal('Search', `<input id="pq" class="pal-q-in" type="text" placeholder="Channels, tasks, squads, actions"
      autocomplete="off" role="combobox" aria-expanded="true" aria-controls="pl" aria-autocomplete="list">
    <div class="pal-list" id="pl" role="listbox" aria-label="Results"></div>`, (m, close) => {
    /* the list is driven from the text field, so it has to answer the arrow keys
       and Enter — reaching for the mouse mid-search is what makes a palette
       feel like a menu instead of a search box */
    let cur = 0;
    const btns = () => $$('.pal-i', m);
    const mark = () => {
      const bs = btns();
      bs.forEach((b, n) => {
        b.dataset.active = String(n === cur);
        b.setAttribute('aria-selected', String(n === cur));
      });
      const a = bs[cur];
      if (a) { a.scrollIntoView({ block: 'nearest' }); $('#pq', m).setAttribute('aria-activedescendant', a.id); }
      else $('#pq', m).removeAttribute('aria-activedescendant');
    };
    const draw = (term) => {
      const hits = items.filter(i => !term || (i.t + ' ' + (i.m || '')).toLowerCase().includes(term.toLowerCase())).slice(0, 30);
      $('#pl', m).innerHTML = hits.length ? hits.map((i, n) =>
        `<button class="pal-i" role="option" id="pal-o-${n}" data-i="${items.indexOf(i)}"><span class="t">${esc(i.t)}</span><span class="meta">${esc(i.m || i.g)}</span></button>`).join('')
        : `<p class="pal-empty">Nothing matches <b>${esc(term)}</b>.</p>`;
      btns().forEach((b, n) => {
        b.onclick = () => { close(); items[+b.dataset.i].run(); };
        b.onmousemove = () => { if (cur !== n) { cur = n; mark(); } };
      });
      cur = 0; mark();
    };
    draw('');
    $('#pq', m).focus();
    $('#pq', m).oninput = (e) => draw(e.target.value);
    $('#pq', m).onkeydown = (e) => {
      const bs = btns();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!bs.length) return;
        e.preventDefault();
        cur = (cur + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length;
        mark();
      } else if (e.key === 'Enter') {
        const a = bs[cur];
        if (!a) return;
        e.preventDefault();
        close(); items[+a.dataset.i].run();
      }
    };
  });
};
$('#pal-open').onclick = openPalette;
$('#side-search').onclick = openPalette;
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  if (e.key === 'Escape') { $('#modal').hidden = true; $('#modal-scrim').hidden = true; closeSw(); }
});

/* squad updates arriving over the socket */
function applySquad(sq) {
  if (S.squad?.id !== sq.id) return;
  S.squad = { ...S.squad, ...sq };
  $('#sw-n').textContent = sq.name;
  $('#sw-s').textContent = `${sq.kindLabel} · ${sq.members.length} member${sq.members.length === 1 ? '' : 's'}`;
  renderRoster(); renderSquadList();
}

/* deep links: /?invite=<id> and /?meeting=<id> */
async function redeemInvite(inviteId) {
  try {
    const info = await api('GET', `/api/invites/${inviteId}`);
    const { squad } = await api('POST', `/api/invites/${inviteId}/accept`);
    history.replaceState({}, '', location.pathname);
    await loadSquads();
    await openSquad(squad.id);
    toast(`You are in ${squad.name}`, `${info.squad.kindLabel} · say hello in #general`, 'ok');
  } catch (e) {
    toast('That invite did not work', e.message);
    history.replaceState({}, '', location.pathname);
  }
}

const params = new URL(location).searchParams;
let pendingInvite = params.get('invite');
let pendingMeeting = params.get('meeting');
let pendingPass = params.get('pass');

if (pendingInvite) {
  /* show what they were invited to, even before they have an account */
  api('GET', `/api/invites/${pendingInvite}`).then(info => {
    const note = document.querySelector('.gate-sub');
    if (note) note.innerHTML = `You have been invited to <b>${esc(info.squad.name)}</b> — ${esc(info.squad.kindLabel)}.
      Sign in or create an account and you will join automatically.`;
    if ($('#app').hidden) openAuth();
  }).catch(() => {});
}

/* Whatever the link asked for, handled after the session exists. This used to
   run only at page load, so anyone who followed an invite link and then made
   an account was signed in but never joined the squad — and the tour, which
   needs a squad, never appeared for them either. */
async function handleDeepLink() {
  if (!S.me) return;
  if (pendingInvite) { const id = pendingInvite; pendingInvite = null; return redeemInvite(id); }
  if (pendingMeeting) {
    /* Drop the parameter before joining. Left in place it re-fires on every
       reload, so one dead link turned into an error toast on each load with no
       way to clear it short of editing the address bar. */
    const id = pendingMeeting, pass = pendingPass;
    pendingMeeting = pendingPass = null;
    history.replaceState({}, '', location.pathname);
    setTimeout(() => joinMeeting(id, pass), 400);
  }
}

boot().then(handleDeepLink);

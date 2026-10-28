(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const app = $('#app');
  let me = null;

  // ---------- utilities ----------
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isBoss = () => me && (me.role === 'admin' || me.role === 'manager');
  const canAssign = () => me && me.role !== 'employee';
  const ROLE = { admin: 'Admin', manager: 'Manager', lead: 'Team lead', employee: 'Employee' };
  const STATUS = { assigned: 'Not started', in_progress: 'In progress', submitted: 'Waiting for approval', completed: 'Completed' };
  const PRIORITY = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
  const PSTATUS = { active: 'Active', on_hold: 'On hold', closed: 'Closed' };
  const RSTATUS = { needs_team: 'Needs a team', open: 'Open', assigned: 'Assigned', delivered: 'Delivered', closed: 'Closed', cancelled: 'Cancelled' };
  const FILE_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.zip';
  const fileInput = (label = 'Attach files (optional)') => `<label class="f"><span>${label}</span><input type="file" name="files" multiple accept="${FILE_ACCEPT}"><small class="muted">PDF, Word, Excel, PowerPoint, images, text or ZIP · up to 25 MB each, 5 at a time</small></label>`;
  const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const fileList = files => files && files.length ? `<ul class="files">${files.map(f => `<li><a href="/api/files/${f.id}" download>${esc(f.original_name)}</a> <span class="muted">${fmtSize(f.size)}</span></li>`).join('')}</ul>` : '';
  // "X or any manager" from the server's approvers list (never includes the assignee).
  const approverText = a => {
    if (!a) return 'the person who assigned it';
    const others = [a.names.join(', '), a.any_manager ? (a.names.length ? 'or any manager' : 'any manager') : ''].filter(Boolean).join(' ');
    if (!a.self) return others;
    return others ? others + ' (as a manager you can also approve it yourself)' : 'you (as a manager you can approve it yourself)';
  };
  const reqPill = r => `<span class="pill rq-${esc(r.status)}">${RSTATUS[r.status] || esc(r.status)}</span>`;
  // Copy plain fields into a FormData (for requests that may carry files).
  function formData(fields, filesInput) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, v);
    for (const f of (filesInput && filesInput.files) || []) fd.append('files', f);
    return fd;
  }

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
      body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (res.status === 401 && path !== '/login') { me = null; location.hash = '#/login'; }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  let tt;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2800); }

  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d.replace(' ', 'T') + (d.includes('Z') || d.includes('T') ? '' : 'Z'));
    return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(d) {
    const dt = new Date(d.replace(' ', 'T') + (d.includes('Z') || d.includes('T') ? '' : 'Z'));
    return dt.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function dueText(t) {
    if (!t.deadline) return 'No deadline';
    if (t.status === 'completed') return 'Due ' + fmtDate(t.deadline);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(t.deadline + 'T00:00:00') - today) / 864e5);
    if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue`;
    if (days === 0) return 'Due today';
    if (days === 1) return 'Due tomorrow';
    return 'Due ' + fmtDate(t.deadline);
  }
  function statusPill(t) {
    if (t.overdue) return `<span class="pill st-overdue">Overdue</span>`;
    return `<span class="pill st-${t.status}">${STATUS[t.status]}</span>`;
  }
  function bar(total, done, prog = 0, over = 0) {
    if (!total) return `<div class="bar"></div>`;
    const w = n => (n / total * 100).toFixed(1) + '%';
    return `<div class="bar" role="img" aria-label="${done} of ${total} completed"><i class="d" style="width:${w(done)}"></i><i class="p" style="width:${w(prog)}"></i><i class="o" style="width:${w(over)}"></i></div>`;
  }
  const options = (map, sel) => Object.entries(map).map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');

  // ---------- modal ----------
  const modal = $('#modal'), modalForm = $('#modalForm');
  function openModal(html, onSubmit) {
    modalForm.innerHTML = html + `<p class="err" id="mErr"></p>`;
    modalForm.onsubmit = async e => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      e.preventDefault();
      const btn = modalForm.querySelector('[type=submit]:not([value=cancel])');
      btn && (btn.disabled = true);
      try { await onSubmit(new FormData(modalForm)); modal.close(); }
      catch (err) { $('#mErr').textContent = err.message; }
      finally { btn && (btn.disabled = false); }
    };
    modal.showModal();
    const first = modalForm.querySelector('input,select,textarea'); first && first.focus();
  }
  const modalActions = label => `<div class="modal-actions"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn" type="submit">${esc(label)}</button></div>`;

  // ---------- shell ----------
  function renderNav(route) {
    const items = [['#/', 'Dashboard'], ['#/tasks', me.role === 'employee' ? 'My tasks' : 'Tasks'], ['#/requests', 'Requests'], ['#/projects', 'Projects']];
    items.push(['#/teams', 'Teams'], ['#/chat', `Chat <span class="pill nav-count" id="chatCount"${chatUnread ? '' : ' hidden'}>${chatUnread > 99 ? '99+' : chatUnread}</span>`], ['#/history', 'History']);
    $('#nav').innerHTML = items.map(([h, l]) => {
      const cur = h === '#/' ? route === '' : route.startsWith(h.slice(2));
      return `<a href="${h}"${cur ? ' aria-current="page"' : ''}>${l}</a>`;
    }).join('');
    $('#meName').textContent = me.name; $('#meName').title = me.name; // long names are cut short with "…"
    $('#topbar').hidden = false;
    document.documentElement.style.setProperty('--topbar-h', $('#topbar').offsetHeight + 'px'); // the chat page fills the rest
    if (!stream || stream.readyState === EventSource.CLOSED) { openStream(); startChatPolling(); }
  }
  $('#logoutBtn').onclick = async () => { closeStream(); await api('/logout', { method: 'POST' }).catch(() => {}); me = null; setChatUnread(0); location.hash = '#/login'; };

  async function router() {
    const route = location.hash.replace(/^#\/?/, '');
    // Signed-out pages: sign in, "Forgot password?" and the "Set your password" link from an email.
    const page = route.split('?')[0];
    if (page === 'login' || page === 'forgot' || page === 'set-password') {
      $('#topbar').hidden = true;
      return page === 'login' ? viewLogin() : page === 'forgot' ? viewForgot() : viewSetPassword();
    }
    if (!me) {
      try { me = (await api('/me')).user; } catch (e) { location.hash = '#/login'; return; }
    }
    // The old "My team" page (and People for non-managers) is now the Teams page.
    if (route === 'my-team') return location.replace('#/teams');
    // People is part of the Teams page now ("All people", managers/admins); old links still work.
    if (route.split('?')[0] === 'people') return location.replace(isBoss() ? '#/teams?view=people' : '#/teams');
    renderNav(route);
    const parts = route.split('?')[0].split('/');
    // Moving between chats keeps the chat page (and its list) in place.
    if (parts[0] === 'chat' && chatPage()) return viewChat(Number(parts[1]) || null).catch(e => toast(e.message));
    app.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      if (route === '') await viewDashboard();
      else if (parts[0] === 'tasks' && parts[1]) await viewTask(Number(parts[1]));
      else if (parts[0] === 'tasks') await viewTasks();
      else if (parts[0] === 'projects') await viewProjects();
      else if (parts[0] === 'requests' && parts[1]) await viewRequest(Number(parts[1]));
      else if (parts[0] === 'requests') await viewRequests();
      else if (parts[0] === 'teams' && parts[1]) await viewTeam(Number(parts[1]));
      else if (parts[0] === 'teams') await viewTeams();
      else if (parts[0] === 'history') await viewHistory();
      else if (parts[0] === 'chat') await viewChat(Number(parts[1]) || null);
      else if (parts[0] === 'account') await viewAccount();
      else app.innerHTML = `<div class="empty">This page doesn’t exist. <a href="#/">Go to the dashboard</a>.</div>`;
    } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    app.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', router);

  // ---------- login ----------
  function viewLogin() {
    app.innerHTML = `<div class="login">
      <form class="card login-card" id="loginForm">
        <img class="login-banner" src="/branding/hifocus-banner.png" alt="Hi-Focus – Enhancing your sixth sense" width="1600" height="820">
        <div class="brand"><span class="brand-mark" aria-hidden="true"></span>TaskDesk</div>
        <h1 style="font-size:1.25rem;margin-bottom:16px">Sign in</h1>
        <label class="f"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <label class="f"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <p class="err" id="loginErr"></p>
        <button class="btn" style="width:100%">Sign in</button>
      </form>
      <p style="font-size:.875rem;margin-top:14px"><a href="#/forgot">Forgot password?</a></p>
    </div>`;
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        me = (await api('/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } })).user;
        location.hash = '#/';
      } catch (err) { $('#loginErr').textContent = err.message; }
    };
  }

  // The card used by the signed-out pages (banner, brand, heading, body).
  const loginCard = (title, body, id = '') => `<div class="login">
      <form class="card login-card"${id ? ` id="${id}"` : ''} novalidate>
        <img class="login-banner" src="/branding/hifocus-banner.png" alt="Hi-Focus – Enhancing your sixth sense" width="1600" height="820">
        <div class="brand"><span class="brand-mark" aria-hidden="true"></span>TaskDesk</div>
        <h1 style="font-size:1.25rem;margin-bottom:16px">${title}</h1>${body}
      </form>
      <p style="font-size:.875rem;margin-top:14px"><a href="#/login">Back to sign in</a></p>
    </div>`;
  // "Forgot password?": always the same answer, whether or not the email has an account.
  function viewForgot() {
    app.innerHTML = loginCard('Reset your password', `
        <p class="muted" style="margin:-6px 0 14px;font-size:.9375rem">Enter your email and we’ll send you a link to choose a new password.</p>
        <label class="f"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <p class="err" id="fErr"></p>
        <button class="btn" style="width:100%">Send link</button>`, 'forgotForm');
    $('#forgotForm').onsubmit = async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        const r = await api('/password/forgot', { method: 'POST', body: { email: new FormData(e.target).get('email') } });
        e.target.querySelector('h1').insertAdjacentHTML('afterend', `<p class="ok-note" role="status">${esc(r.message)} Check your inbox (and spam folder). The link works for 1 hour.</p>`);
        e.target.querySelectorAll('label, .err, button').forEach(x => x.remove());
        e.target.querySelector('p.muted').remove();
      } catch (err) { $('#fErr').textContent = err.message; btn.disabled = false; }
    };
  }
  // The link from a welcome or reset email: #/set-password?token=… The token is taken off the address bar once read.
  let pwToken = '';
  async function viewSetPassword() {
    const t = new URLSearchParams(location.hash.split('?')[1] || '').get('token');
    if (t) { pwToken = t; history.replaceState(null, '', '#/set-password'); }
    const dead = msg => {
      app.innerHTML = loginCard('This link can’t be used', `<p style="margin-bottom:16px">${esc(msg)}</p><a class="btn" style="width:100%;text-align:center" href="#/forgot">Send a new link</a>`);
    };
    if (!pwToken) return dead('Open the link from your email again. Each link works once.');
    let info;
    try { info = await api('/password/check?token=' + encodeURIComponent(pwToken)); } catch (err) { return dead(err.message); }
    const welcome = info.purpose === 'welcome';
    app.innerHTML = loginCard(welcome ? 'Set your password' : 'Choose a new password', `
        <p class="muted" style="margin:-6px 0 14px;font-size:.9375rem">${welcome ? `Welcome, ${esc(info.name)}. Choose the password you’ll use to sign in.` : `Hi ${esc(info.name)}. Choose a new password. This signs you out everywhere.`}</p>
        <label class="f"><span>New password</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
        <label class="f"><span>Repeat the password</span><input name="again" type="password" minlength="8" autocomplete="new-password" required></label>
        <p class="muted" style="font-size:.8125rem;margin-top:-6px">At least 8 characters.</p>
        <p class="err" id="spErr"></p>
        <button class="btn" style="width:100%">${welcome ? 'Set password' : 'Change password'}</button>`, 'setPwForm');
    $('#setPwForm').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target), pw = fd.get('password');
      if (pw.length < 8) return $('#spErr').textContent = 'Password must be at least 8 characters.';
      if (pw !== fd.get('again')) return $('#spErr').textContent = 'The two passwords don’t match.';
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        await api('/password/set', { method: 'POST', body: { token: pwToken, password: pw } });
        pwToken = ''; me = null; closeStream();
        app.innerHTML = loginCard('Password set', `<p class="ok-note" role="status">Password set. Sign in with your new password.</p><a class="btn" style="width:100%;text-align:center" href="#/login">Sign in</a>`);
      } catch (err) { $('#spErr').textContent = err.message; btn.disabled = false; }
    };
  }

  // ---------- dashboard ----------
  async function viewDashboard() {
    const d = await api('/dashboard');
    const t = d.totals;
    const greeting = me.role === 'employee' ? 'Your tasks at a glance' : isBoss() ? 'All projects and people' : 'Your team’s work';
    const stat = (n, l, c, href) => `<a class="stat" href="${href}" style="--c:${c}"><b>${n}</b><span>${l}</span></a>`;
    const legend = `<div class="legend"><span><i style="background:var(--s-done)"></i>Completed</span><span><i style="background:var(--s-prog)"></i>In progress</span><span><i style="background:var(--s-over)"></i>Overdue</span><span><i style="background:var(--soft)"></i>Not started</span></div>`;

    const projects = d.projects.length ? `<ul class="rows">${d.projects.map(p => `<li>
        <div class="row-top"><a href="#/tasks?project=${p.id}">${esc(p.name)}</a><span class="num">${p.completed || 0} of ${p.total} completed · ${Math.round((p.completed || 0) / p.total * 100)}%</span></div>
        ${bar(p.total, p.completed || 0, 0, p.overdue || 0)}</li>`).join('')}</ul>`
      : `<div class="empty">No project tasks yet.</div>`;

    const people = d.people.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th class="n">Assigned</th><th class="n">Completed</th><th class="n">In progress</th><th class="n">Overdue</th><th style="min-width:120px">Progress</th></tr></thead>
        <tbody>${d.people.map(p => `<tr>
          <td><a href="#/tasks?assignee=${p.id}">${esc(p.name)}</a><div class="muted" style="font-size:.8125rem">${ROLE[p.role]}</div></td>
          <td class="n">${p.total}</td><td class="n">${p.completed || 0}</td><td class="n">${p.in_progress || 0}</td>
          <td class="n" style="${p.overdue ? 'color:var(--s-over);font-weight:600' : ''}">${p.overdue || 0}</td>
          <td>${bar(p.total, p.completed || 0, (p.in_progress || 0), 0)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">No tasks assigned yet.</div>`;

    const due = d.due_soon.length ? `<ul class="rows">${d.due_soon.map(x => `<li>
        <div class="row-top"><a href="#/tasks/${x.id}">${esc(x.title)}</a>${statusPill(x)}</div>
        <div class="num">${esc(dueText(x))}${me.role !== 'employee' ? ' · ' + esc(x.assignee_name) : ''}</div></li>`).join('')}</ul>`
      : `<div class="empty">Nothing due in the next 7 days.</div>`;

    const approvals = d.awaiting_me && d.awaiting_me.length ? `<section class="card"><h2>Waiting for your approval</h2><ul class="rows">${d.awaiting_me.map(x => `<li>
        <div class="row-top"><a href="#/tasks/${x.id}">${esc(x.title)}</a>${statusPill(x)}</div>
        <div class="num">Submitted by ${esc(x.assignee_name)}${x.submitted_at ? ' · ' + fmtDateTime(x.submitted_at) : ''}</div></li>`).join('')}</ul></section>` : '';

    // Open requests for teams the user leads (managers/admins: all, plus those without a team).
    const toAssign = d.to_assign && d.to_assign.length ? `<section class="card"><h2>Requests to assign</h2><ul class="rows">${d.to_assign.map(r => `<li>
        <div class="row-top"><a href="#/requests/${r.id}">${esc(r.title)}</a>
          ${r.status === 'needs_team' ? `<a class="btn ghost small" href="#/requests/${r.id}">Choose team</a>` : `<button class="btn small" data-assignreq="${r.id}">Assign</button>`}</div>
        <div class="num">${r.team_name ? esc(r.team_name) + ' · ' : 'No team yet · '}Requested by ${esc(r.requested_by_name)} · Needed by ${fmtDate(r.needed_by)}</div></li>`).join('')}</ul></section>` : '';

    app.innerHTML = `
      <div class="page-head"><div><h1>Dashboard</h1><p>${greeting}</p></div>
        ${canAssign() ? `<button class="btn" id="newTask">Assign a task</button>` : ''}</div>
      <div class="stats">
        ${stat(t.total, 'Tasks assigned', 'var(--accent)', '#/tasks')}
        ${stat(t.completed, 'Completed', 'var(--s-done)', '#/tasks?status=completed')}
        ${stat(t.in_progress, 'In progress', 'var(--s-prog)', '#/tasks?status=in_progress')}
        ${stat(t.submitted, 'Waiting for approval', 'var(--s-sub)', '#/tasks?status=submitted')}
        ${stat(t.not_started, 'Not started', 'var(--s-not)', '#/tasks?status=assigned')}
        ${stat(t.overdue, 'Overdue', 'var(--s-over)', '#/tasks?status=overdue')}
      </div>
      <div class="cols">
        <div class="stack">
          ${me.role !== 'employee' ? `<section class="card"><h2>Employees</h2>${legend}${people}</section>` : ''}
          <section class="card"><h2>Projects</h2>${me.role === 'employee' ? legend : ''}${projects}</section>
        </div>
        <div class="stack">
          ${toAssign}
          ${approvals}
          <section class="card"><h2>Due in the next 7 days</h2>${due}</section>
          <section class="card"><h2>This week</h2><p style="margin:0"><b style="font-size:1.5rem">${t.completed_week}</b> <span class="muted">tasks completed in the last 7 days</span></p></section>
        </div>
      </div>`;
    const nb = $('#newTask'); if (nb) nb.onclick = () => taskForm();
    app.querySelectorAll('[data-assignreq]').forEach(b => b.onclick = () => assignRequestModal(Number(b.dataset.assignreq)).catch(e => toast(e.message)));
  }

  // ---------- task list ----------
  // ---------- team tabs (Tasks, Requests, Projects, History) ----------
  // "All", then the teams the user works with: managers/admins every team + "No team"; leads the teams they lead and
  // their own team; employees their own team (no bar without a team). The tab only narrows what the server already
  // allows (the lists filter with ?team= inside the user's normal scope). The choice is kept in the URL.
  function teamTabsFor(teams) {
    const tab = t => ({ id: String(t.id), name: t.name });
    if (isBoss()) return [{ id: 'all', name: 'All' }, ...teams.map(tab), { id: 'none', name: 'No team' }];
    const led = teams.filter(t => t.leads.some(l => l.id === me.id));
    const own = teams.find(t => t.id === me.team_id);
    const mine = own && !led.includes(own) ? [...led, own] : led;
    return mine.length ? [{ id: 'all', name: 'All' }, ...mine.map(tab)] : [];
  }
  // Without ?team=: managers "All", leads their first led team, employees their team.
  function currentTeamTab(q, teams, tabs) {
    const v = q.get('team');
    if (tabs.some(t => t.id === v)) return v;
    if (!tabs.length || isBoss()) return 'all';
    const led = teams.find(t => t.leads.some(l => l.id === me.id));
    return String(led ? led.id : me.team_id);
  }
  const tabsHtml = (tabs, cur) => tabs.length ? `<nav class="team-tabs" aria-label="Teams">${tabs.map(t =>
    `<button type="button" data-tab="${esc(t.id)}" aria-pressed="${t.id === cur}">${esc(t.name)}</button>`).join('')}</nav>` : '';
  // The page's query string: read it, and change some keys (empty value = remove) by going to the new URL.
  function pageQuery(page) {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const go = changes => {
      for (const [k, v] of Object.entries(changes)) { if (v) q.set(k, v); else q.delete(k); }
      location.hash = `#/${page}` + (q.toString() ? '?' + q : '');
    };
    return { q, go };
  }
  // Wire the tab buttons, and a search box that applies its text 300 ms after typing stops (and keeps the focus).
  let refocusSearch = null;
  function wireTabs(go) {
    app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => go({ team: b.dataset.tab }));
    const sw = $('#teamSwitch'); if (sw) sw.onchange = () => go({ team: sw.value });
  }
  // ---------- team blocks (landing view of Tasks, Requests and Projects) ----------
  // Shown when the URL names no team and no list filter (old links with filters keep opening a list). Employees who
  // only see their own team skip it. Cards = the teams the user could pick as a tab, own team first; then "All teams".
  const LIST_KEYS = { tasks: ['status', 'project', 'assignee', 'mine', 'due', 'priority', 'review', 'sort', 'view'], requests: ['status', 'dir'], projects: [] };
  const isLanding = (page, q, tabs) => !q.get('team') && tabs.length > 0 && !LIST_KEYS[page].some(k => q.get(k)) && !(me.role === 'employee' && tabs.length <= 2);
  async function renderLanding({ page, title, sub, actions = '', placeholder, body, tabs, q, go, results }) {
    const sum = await api(`/${page}/summary`);
    const own = String(me.team_id || '');
    const ids = tabs.filter(t => t.id !== 'all').map(t => t.id).sort((a, b) => (b === own) - (a === own));
    const card = (id, name, c, mine) => `<a class="card team-card block-card${mine ? ' mine' : ''}${id === 'all' ? ' all-card' : ''}" href="#/${page}?team=${esc(id)}">
        <div class="row-top"><h2>${esc(name)}</h2>${mine ? '<span class="pill accent">Your team</span>' : ''}</div>${body(c || {})}</a>`;
    const searching = !!q.get('q');
    app.innerHTML = `
      <div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div>${actions}</div>
      <div class="filters"><input type="search" id="landSearch" class="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" value="${esc(q.get('q') || '')}"></div>
      ${searching ? `<h2 class="results-head">Results in all your teams</h2>${results}`
        : `<div class="team-grid">${ids.map(id => card(id, tabs.find(t => t.id === id).name, sum.teams[id], id === own)).join('')}${card('all', 'All teams', sum.all, false)}</div>`}`;
    wireSearch('landSearch', go);
  }
  const stat = (n, label, cls = '') => `<span class="${cls}"><b>${n || 0}</b> ${label}</span>`;
  // Inside a team: "← All teams", the team's name, and a dropdown to switch team directly.
  function teamHeaderHtml(page, tabs, cur) {
    if (!tabs.length) return '';
    const name = cur === 'all' ? 'All teams' : (tabs.find(t => t.id === cur) || {}).name || '';
    const back = !(me.role === 'employee' && tabs.length <= 2); // those employees have no grid to go back to
    return `<div class="team-head">${back ? `<a href="#/${page}" class="back-link">← All teams</a>` : ''}<h2>${esc(name)}</h2>
      <select id="teamSwitch" aria-label="Switch team">${tabs.map(t => `<option value="${esc(t.id)}"${t.id === cur ? ' selected' : ''}>${t.id === 'all' ? 'All teams' : esc(t.name)}</option>`).join('')}</select></div>`;
  }
  function wireSearch(id, go, key = 'q') {
    const box = $('#' + id); if (!box) return;
    let t;
    box.oninput = () => { clearTimeout(t); t = setTimeout(() => { refocusSearch = id; go({ [key]: box.value.trim() }); }, 300); };
    // After the page re-renders (the router then focuses the page), put the cursor back at the end of the search text.
    if (refocusSearch === id) { refocusSearch = null; setTimeout(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }); }
  }
  // Collapsible groups ("R&D (5) · 3 open"): open/closed is remembered for this browser session.
  const groupKey = k => 'td-group:' + k;
  function groupOpen(k) { try { return sessionStorage.getItem(groupKey(k)) !== 'closed'; } catch (e) { return true; } }
  function wireGroups() {
    app.querySelectorAll('details[data-group]').forEach(d => d.ontoggle = () => {
      try { sessionStorage.setItem(groupKey(d.dataset.group), d.open ? 'open' : 'closed'); } catch (e) { /* private mode */ }
    });
  }
  const groupHtml = (key, title, meta, body) => `<details class="group" data-group="${esc(key)}"${groupOpen(key) ? ' open' : ''}>
    <summary><span class="g-title">${esc(title)}</span> <span class="g-meta">${meta}</span></summary>${body}</details>`;
  // Group rows by team: the tab order first, then any other team (alphabetical), then "No team" / the fallback.
  function byTeam(rows, idOf, nameOf, tabs, none = 'No team') {
    const groups = new Map();
    for (const r of rows) {
      const id = idOf(r) ? String(idOf(r)) : 'none';
      if (!groups.has(id)) groups.set(id, { id, name: id === 'none' ? none : nameOf(r), rows: [] });
      groups.get(id).rows.push(r);
    }
    const order = tabs.map(t => t.id);
    return [...groups.values()].sort((a, b) => (a.id === 'none') - (b.id === 'none')
      || ((order.indexOf(a.id) + 1 || 1e6) - (order.indexOf(b.id) + 1 || 1e6)) || a.name.localeCompare(b.name));
  }

  // Tasks: team tabs (a task belongs to its assignee's team), List (grouped by team on "All") or Board, search, quick
  // filter chips and sort — all in the URL, all applied by the server inside the user's normal task scope.
  async function viewTasks() {
    const { q, go } = pageQuery('tasks');
    const { teams } = await api('/teams');
    const tabs = teamTabsFor(teams), landing = isLanding('tasks', q, tabs), cur = landing ? 'all' : currentTeamTab(q, teams, tabs);
    const params = new URLSearchParams();
    for (const k of ['status', 'project', 'assignee', 'mine', 'q', 'due', 'priority', 'review', 'sort']) if (q.get(k)) params.set(k, q.get(k));
    if (cur !== 'all') params.set('team', cur);
    const [{ tasks }, { projects }, { users }] = landing && !q.get('q') ? [{ tasks: [] }, { projects: [] }, { users: [] }]
      : await Promise.all([api('/tasks?' + params), api('/projects'), api('/users')]);
    const board = q.get('view') === 'board';
    const filtered = ['status', 'project', 'assignee', 'mine', 'q', 'due', 'priority', 'review'].some(k => q.get(k));
    const people = /^\d+$/.test(cur) ? users.filter(u => u.team_id === Number(cur)) : cur === 'none' ? users.filter(u => !u.team_id) : users;

    const row = (t, withTeam) => `<li><a href="#/tasks/${t.id}">
        <span class="t-title">${esc(t.title)}</span>
        <span class="t-meta">${withTeam ? `<span>${esc(t.team_name || 'No team')}</span>` : ''}<span>${esc(dueText(t))}</span>${me.role !== 'employee' ? `<span>${esc(t.assignee_name)}</span>` : `<span>From ${esc(t.assigned_by_name)}</span>`}${t.project_name ? `<span>${esc(t.project_name)}</span>` : ''}<span class="pr-${t.priority}">${PRIORITY[t.priority]} priority</span></span>
        <span class="t-side">${statusPill(t)}<span class="mini" aria-label="${t.progress}% done"><i style="width:${t.progress}%"></i></span></span>
      </a></li>`;
    const counts = list => {
      const open = list.filter(t => t.status !== 'completed').length, over = list.filter(t => t.overdue).length;
      return `(${list.length}) · ${open} open${over ? ` · <span class="over">${over} overdue</span>` : ''}`;
    };
    if (landing) return renderLanding({ page: 'tasks', title: me.role === 'employee' ? 'My tasks' : 'Tasks', tabs, q, go,
      sub: 'Choose a team, or open all teams.', placeholder: 'Search tasks in all your teams',
      actions: canAssign() ? `<button class="btn" id="newTask">Assign a task</button>` : '',
      body: c => `<p class="block-stats">${stat(c.open, 'open')}${stat(c.overdue, 'overdue', c.overdue ? 'over' : '')}${stat(c.submitted, 'waiting for approval')}${stat(c.done_week, 'completed in 7 days')}</p>`,
      results: tasks.length ? `<ul class="task-list">${tasks.map(t => row(t, true)).join('')}</ul>` : '<div class="card empty">No tasks match.</div>'
    }).then(() => { const nb = $('#newTask'); if (nb) nb.onclick = () => taskForm(); });
    let body;
    if (!tasks.length) body = `<div class="card empty">${filtered ? 'No tasks match these filters.' : canAssign() ? 'No tasks yet. Assign the first one to get started.' : 'No tasks have been assigned to you yet.'}</div>`;
    else if (board) {
      // Board: one column per status; Completed shows the 20 most recently completed.
      const cols = [['assigned', 'Not started'], ['in_progress', 'In progress'], ['submitted', 'Waiting for approval'], ['completed', 'Completed']];
      const card = t => `<a class="b-card" href="#/tasks/${t.id}"><b>${esc(t.title)}</b>
        <span class="muted">${esc(t.assignee_name)}</span>
        <span class="b-meta"><span class="${t.overdue ? 'over' : 'muted'}">${esc(dueText(t))}</span><span class="pr-${t.priority}">${PRIORITY[t.priority]}</span></span></a>`;
      body = `<div class="board">${cols.map(([st, label]) => {
        let list = tasks.filter(t => t.status === st), more = 0;
        if (st === 'completed') { list = list.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at))); more = Math.max(0, list.length - 20); list = list.slice(0, 20); }
        return `<section class="board-col" aria-label="${label}"><h2>${label} <span class="muted">${list.length + more}</span></h2>
          ${list.map(card).join('') || '<p class="muted b-empty">None</p>'}${more ? `<p class="muted b-empty">+${more} more in the list view</p>` : ''}</section>`;
      }).join('')}</div>`;
    } else if (cur === 'all' && tabs.length) {
      body = byTeam(tasks, t => t.team_id, t => t.team_name, tabs).map(g =>
        groupHtml('tasks:' + g.id, g.name, counts(g.rows), `<ul class="task-list">${g.rows.map(t => row(t)).join('')}</ul>`)).join('');
    } else body = `<ul class="task-list">${tasks.map(t => row(t)).join('')}</ul>`;

    const chip = (key, val, label) => `<button type="button" class="chip-filter" data-chip="${key}=${val}" aria-pressed="${q.get(key) === val}">${label}</button>`;
    app.innerHTML = `
      <div class="page-head"><div><h1>${me.role === 'employee' ? 'My tasks' : 'Tasks'}</h1><p>${tasks.length} task${tasks.length === 1 ? '' : 's'}</p></div>
        <div class="inline-actions"><div class="seg" role="group" aria-label="View">
          <button type="button" data-view="" aria-pressed="${!board}">List</button><button type="button" data-view="board" aria-pressed="${board}">Board</button></div>
        ${canAssign() ? `<button class="btn" id="newTask">Assign a task</button>` : ''}</div></div>
      ${teamHeaderHtml('tasks', tabs, cur)}
      <div class="filters">
        <input type="search" id="tSearch" class="search" placeholder="Search title or description" aria-label="Search tasks" value="${esc(q.get('q') || '')}">
        <select id="fStatus" aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="open"${q.get('status') === 'open' ? ' selected' : ''}>All open</option>
          ${options(STATUS, q.get('status'))}
          <option value="overdue"${q.get('status') === 'overdue' ? ' selected' : ''}>Overdue</option>
        </select>
        <select id="fProject" aria-label="Filter by project"><option value="">All projects</option>
          ${projects.map(p => `<option value="${p.id}"${String(p.id) === q.get('project') ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        ${me.role !== 'employee' ? `<select id="fAssignee" aria-label="Filter by person"><option value="">Everyone</option>
          ${people.map(u => `<option value="${u.id}"${String(u.id) === q.get('assignee') ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
          <select id="fMine" aria-label="Filter by who assigned"><option value="">Assigned by anyone</option><option value="assigned_by_me"${q.get('mine') ? ' selected' : ''}>Assigned by me</option></select>` : ''}
        <select id="fSort" aria-label="Sort"><option value="">Sort: deadline</option><option value="priority"${q.get('sort') === 'priority' ? ' selected' : ''}>Sort: priority</option><option value="newest"${q.get('sort') === 'newest' ? ' selected' : ''}>Sort: newest</option></select>
      </div>
      <div class="chips-row" role="group" aria-label="Quick filters">${chip('due', 'overdue', 'Overdue')}${chip('due', 'week', 'Due this week')}${chip('priority', 'high', 'Urgent/High')}${canAssign() ? chip('review', 'mine', 'Waiting for my approval') : ''}</div>
      ${body}`;
    wireTabs(go); wireGroups(); wireSearch('tSearch', go);
    app.querySelectorAll('[data-view]').forEach(b => b.onclick = () => go({ view: b.dataset.view }));
    app.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { const [k, v] = b.dataset.chip.split('='); go({ [k]: q.get(k) === v ? '' : v }); });
    $('#fStatus').onchange = e => go({ status: e.target.value });
    $('#fProject').onchange = e => go({ project: e.target.value });
    $('#fSort').onchange = e => go({ sort: e.target.value });
    if ($('#fAssignee')) { $('#fAssignee').onchange = e => go({ assignee: e.target.value }); $('#fMine').onchange = e => go({ mine: e.target.value }); }
    const nb = $('#newTask'); if (nb) nb.onclick = () => taskForm();
  }

  // Person search with chips. Type 1+ letters to see matching people (name, role, team); arrow keys + Enter or click
  // to pick; ✕ removes. `multiple: false` keeps one chip (picking replaces it).
  function personPicker(root, people, { multiple = true, selected = [] } = {}) {
    const input = root.querySelector('input'), list = root.querySelector('[role=listbox]'), chips = root.querySelector('.chips');
    let chosen = selected.slice(), matches = [], active = 0;
    const desc = p => [ROLE[p.role], p.team_name].filter(Boolean).join(' · ');
    const renderChips = () => {
      chips.innerHTML = chosen.map(p => `<span class="chip">${esc(p.name)}<button type="button" data-rm="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button></span>`).join('');
      chips.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { chosen = chosen.filter(p => p.id !== Number(b.dataset.rm)); renderChips(); input.focus(); });
    };
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
    const renderList = () => {
      const q = input.value.trim().toLowerCase();
      matches = !q ? [] : people.filter(p => !chosen.some(c => c.id === p.id) && (p.name.toLowerCase().includes(q) || (p.team_name || '').toLowerCase().includes(q))).slice(0, 8);
      if (!q) return close();
      active = Math.min(active, Math.max(matches.length - 1, 0));
      list.innerHTML = matches.length ? matches.map((p, i) => `<li role="option" id="pp-${p.id}" data-i="${i}" aria-selected="${i === active}">
          <span>${esc(p.name)}</span><small>${esc(desc(p))}</small></li>`).join('')
        : `<li class="none">No one matches “${esc(input.value.trim())}”.</li>`;
      list.hidden = false; input.setAttribute('aria-expanded', 'true');
      if (matches[active]) input.setAttribute('aria-activedescendant', 'pp-' + matches[active].id);
      list.querySelectorAll('[data-i]').forEach(li => li.onmousedown = e => { e.preventDefault(); pick(Number(li.dataset.i)); });
    };
    const pick = i => {
      const p = matches[i]; if (!p) return;
      chosen = multiple ? chosen.concat(p) : [p];
      input.value = ''; active = 0; close(); renderChips(); input.focus();
    };
    input.oninput = () => { active = 0; renderList(); };
    input.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!matches.length) return renderList();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; renderList();
      } else if (e.key === 'Enter') { e.preventDefault(); pick(active); } // never submits the form
      else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Backspace' && !input.value && chosen.length) { chosen.pop(); renderChips(); }
    };
    input.onblur = () => setTimeout(close, 100);
    renderChips();
    return { values: () => chosen.map(p => p.id), people: () => chosen.slice() };
  }
  const pickerHtml = (label, hint) => `<div class="f picker"><span id="pickLabel">${label}</span>
      <div class="picker-box"><span class="chips"></span><input type="text" role="combobox" aria-labelledby="pickLabel" aria-autocomplete="list"
        aria-expanded="false" aria-controls="pickList" autocomplete="off" placeholder="Type a name…"></div>
      <ul role="listbox" id="pickList" hidden></ul><small class="muted">${hint}</small></div>`;

  async function taskForm(task, { preset } = {}) { // preset: a person id to pick in a new task (Teams page "Assign a task")
    const [{ projects }, { users }] = await Promise.all([api('/projects'), api('/users')]);
    const assignable = users.filter(u => u.active); // the server only lists people this user may assign to
    if (!assignable.length) { toast(isBoss() ? 'Add people first, then assign tasks.' : 'No one is in the teams you lead yet. Ask a manager to add team members.'); return; }
    const t = task || { priority: 'medium' };
    openModal(`
      <h2 style="font-size:1.25rem">${task ? 'Edit task' : 'Assign a task'}</h2>
      <label class="f"><span>Title</span><input name="title" required maxlength="200" value="${esc(t.title)}"></label>
      <label class="f"><span>Description</span><textarea name="description" placeholder="What needs to be done, and what counts as finished">${esc(t.description)}</textarea></label>
      ${pickerHtml('Assign to', task ? 'One person. Pick someone else to reassign.' : 'Pick one or more people. Each gets their own copy of the task.')}
      <div class="grid2">
        <label class="f"><span>Project</span><select name="project_id"><option value="">No project</option>
          ${projects.filter(p => p.status !== 'closed' || p.id === t.project_id).map(p => `<option value="${p.id}"${p.id === t.project_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="f"><span>Priority</span><select name="priority">${options(PRIORITY, t.priority)}</select></label>
        <label class="f"><span>Deadline</span><input type="date" name="deadline" value="${esc(t.deadline || '')}"></label>
      </div>
      ${modalActions(task ? 'Save changes' : 'Assign task')}`,
      async fd => {
        const body = Object.fromEntries(fd);
        const ids = picker.values();
        if (!body.title.trim()) throw new Error('Enter a task title.');
        if (!ids.length) throw new Error(task ? 'Choose who this task is for.' : 'Choose at least one person.');
        if (task) { body.assignee_id = ids[0]; await api('/tasks/' + task.id, { method: 'PATCH', body }); toast('Task updated'); }
        else {
          body.assignee_ids = ids;
          const r = await api('/tasks', { method: 'POST', body });
          toast(r.count > 1 ? `Task assigned to ${r.count} people` : 'Task assigned to ' + r.task.assignee_name);
        }
        router();
      });
    const current = task ? [assignable.find(u => u.id === task.assignee_id) || { id: task.assignee_id, name: task.assignee_name }]
      : assignable.filter(u => u.id === preset);
    const picker = personPicker(modalForm.querySelector('.picker'), assignable, { multiple: !task, selected: current });
    if (!task) modalForm.querySelector('[name=title]').focus();
  }


  // Status choices in the update form: "Completed" is only offered to people who may complete directly.
  function statusChoices(t, direct) {
    const c = { assigned: STATUS.assigned, in_progress: STATUS.in_progress };
    if (direct || t.status === 'completed') c.completed = STATUS.completed;
    return c;
  }

  // ---------- task detail ----------
  async function viewTask(id) {
    const { task: t, updates, can_edit, can_update, can_submit, can_review, can_complete_directly, locked, request, approvers, approval_blocked, can_give_back } = await api('/tasks/' + id);
    const isAssignee = t.assignee_id === me.id;
    app.innerHTML = `
      <p style="margin:0 0 10px"><a href="#/tasks">← All tasks</a></p>
      <div class="page-head"><div><h1>${esc(t.title)}</h1><p>${statusPill(t)} <span style="margin-left:6px">${esc(dueText(t))}</span>${request ? ` <span style="margin-left:6px">· From <a href="#/requests/${request.id}">document request #${request.id}</a></span>` : ''}</p></div>
        ${can_edit ? `<div class="inline-actions"><button class="btn ghost" id="editTask">Edit</button><button class="btn danger" id="delTask">Delete</button></div>`
          : can_give_back ? `<div class="inline-actions"><button class="btn ghost" id="giveBack">Give back</button></div>` : ''}</div>
      <div class="cols">
        <div class="stack">
          <section class="card">
            <dl class="meta-grid">
              <div><dt>Assigned to</dt><dd>${esc(t.assignee_name)}</dd></div>
              <div><dt>Assigned by</dt><dd>${esc(t.assigned_by_name)}</dd></div>
              <div><dt>Project</dt><dd>${esc(t.project_name || '—')}</dd></div>
              <div><dt>Priority</dt><dd class="pr-${t.priority}">${PRIORITY[t.priority]}</dd></div>
              <div><dt>Deadline</dt><dd>${fmtDate(t.deadline)}</dd></div>
              <div><dt>Progress</dt><dd>${t.progress}%</dd></div>
              ${t.completed_at ? `<div><dt>Completed on</dt><dd>${fmtDate(t.completed_at)}</dd></div>` : ''}
              ${t.submitted_at && t.status === 'submitted' ? `<div><dt>Submitted on</dt><dd>${fmtDateTime(t.submitted_at)}</dd></div>` : ''}
            </dl>
            <h2 style="margin-top:18px">Description</h2>
            <p class="desc">${t.description ? esc(t.description) : '<span class="muted">No description.</span>'}</p>
          </section>
          ${can_review ? `<section class="card"><h2>Waiting for your approval</h2>
            <p class="muted" style="margin-top:0">${t.assignee_id === me.id ? 'This is your own task. As a manager you can approve it yourself; it will be recorded as self-approved.'
              : `${esc(t.assignee_name)} submitted this task. Check the latest note in the activity, then approve it or send it back.`}</p>
            <div class="inline-actions"><button class="btn" id="approveBtn">Approve</button><button class="btn ghost" id="sendBackBtn">Send back</button></div></section>` : ''}
          ${locked && isAssignee && !can_review ? `<section class="card"><p style="margin:0">Waiting for approval from ${esc(approverText(approvers))}. You can add comments, but status and progress are locked until it is approved or sent back.</p></section>` : ''}
          ${isAssignee && approval_blocked ? `<section class="card warn"><p style="margin:0">${esc(approval_blocked)}</p></section>` : ''}
          ${can_update ? `<section class="card"><h2>${locked ? 'Add a comment' : isAssignee ? 'Post an update' : 'Add a note or change status'}</h2>
            <form id="updForm">
              <label class="f"><span>${locked ? 'Comment' : 'What did you do? Any blockers?'}</span><textarea name="message" placeholder="${isAssignee ? 'For example: finished the login page, waiting for API access' : 'Add a note for the assignee'}"></textarea></label>
              ${fileInput()}
              ${locked ? '' : `<div class="grid2">
                <label class="f"><span>Status</span><select name="status">${options(statusChoices(t, can_complete_directly), t.status)}</select></label>
                <label class="f"><span>Progress</span><span class="progress-input"><input type="range" name="progress" min="0" max="100" step="5" value="${t.progress}"><output>${t.progress}%</output></span></label>
              </div>`}
              <p class="err" id="updErr"></p>
              <div class="inline-actions"><button class="btn">${locked ? 'Post comment' : 'Post update'}</button>
                ${can_submit && !approval_blocked ? `<button class="btn ghost" type="button" id="submitBtn">Submit for approval</button>` : ''}
                ${can_complete_directly ? `<button class="btn ghost" type="button" id="markDone">Mark as completed</button>` : ''}</div>
            </form></section>` : ''}
        </div>
        <section class="card"><h2>Activity</h2>
          <ul class="timeline">${updates.slice().reverse().map(u => `<li>
            <span class="who">${esc(u.user_name)}</span><span class="when">${fmtDateTime(u.created_at)}</span>
            <p>${esc(u.message)}${u.progress !== null && u.progress !== undefined ? ` <span class="muted">· ${u.progress}%</span>` : ''}</p>${fileList(u.files)}</li>`).join('')}</ul>
        </section>
      </div>`;

    if (can_give_back) $('#giveBack').onclick = async () => {
      if (!confirm('Give this request back? Your task is removed (kept in History) and the request goes back to the team as open.')) return;
      try { const r = await api(`/tasks/${t.id}/give-back`, { method: 'POST' }); toast('Request given back to the team'); location.hash = '#/requests/' + r.request_id; }
      catch (e) { toast(e.message); }
    };
    if (can_edit) {
      $('#editTask').onclick = () => taskForm(t);
      $('#delTask').onclick = async () => {
        if (!confirm('Delete this task? It disappears from task lists but stays in History, where a manager can restore it.')) return;
        await api('/tasks/' + t.id, { method: 'DELETE' }); toast('Task deleted'); location.hash = '#/tasks';
      };
    }
    const sb = $('#submitBtn');
    if (sb) sb.onclick = () => openModal(`
      <h2 style="font-size:1.25rem">Submit for approval</h2>
      <p class="muted" style="margin-top:0">${esc(approverText(approvers)).replace(/^./, c => c.toUpperCase())} will review your work and approve it or send it back.</p>
      <label class="f"><span>What was done?</span><textarea name="note" required maxlength="4000" placeholder="A short note about the finished work"></textarea></label>
      ${fileInput('Attach the finished files (optional)')}
      ${modalActions('Submit')}`, async fd => {
        const note = String(fd.get('note') || '').trim();
        if (!note) throw new Error('Write a short note about what was done.');
        await api(`/tasks/${t.id}/submit`, { method: 'POST', body: formData({ note }, modalForm.querySelector('[name=files]')) }); toast('Submitted for approval'); router();
      });
    const ap = $('#approveBtn');
    if (ap) ap.onclick = () => openModal(`
      <h2 style="font-size:1.25rem">Approve task</h2>
      <p class="muted" style="margin-top:0">This marks the task as completed.</p>
      <label class="f"><span>Note (optional)</span><textarea name="note" maxlength="4000"></textarea></label>
      ${modalActions('Approve')}`, async fd => {
        await api(`/tasks/${t.id}/approve`, { method: 'POST', body: { note: fd.get('note') } }); toast('Task approved'); router();
      });
    const sbk = $('#sendBackBtn');
    if (sbk) sbk.onclick = () => openModal(`
      <h2 style="font-size:1.25rem">Send back</h2>
      <p class="muted" style="margin-top:0">${esc(t.assignee_name)} will be told what to fix.</p>
      <label class="f"><span>Reason</span><textarea name="reason" required maxlength="4000"></textarea></label>
      ${modalActions('Send back')}`, async fd => {
        const reason = String(fd.get('reason') || '').trim();
        if (!reason) throw new Error('Write a reason so the assignee knows what to fix.');
        await api(`/tasks/${t.id}/send-back`, { method: 'POST', body: { reason } }); toast('Sent back'); router();
      });
    const f = $('#updForm');
    if (f && locked) {
      f.onsubmit = async e => {
        e.preventDefault();
        const message = f.querySelector('[name=message]').value, fi = f.querySelector('[name=files]');
        if (!message.trim() && !fi.files.length) { $('#updErr').textContent = 'Write a comment first.'; return; }
        try { await api(`/tasks/${t.id}/updates`, { method: 'POST', body: formData({ message }, fi) }); toast('Comment posted'); router(); }
        catch (err) { $('#updErr').textContent = err.message; }
      };
    } else if (f) {
      const range = f.querySelector('[name=progress]'), out = f.querySelector('output'), sel = f.querySelector('[name=status]');
      range.oninput = () => {
        out.textContent = range.value + '%';
        if (+range.value === 100 && can_complete_directly) sel.value = 'completed';
        else if (+range.value > 0 && sel.value === 'assigned') sel.value = 'in_progress';
      };
      sel.onchange = () => { if (sel.value === 'completed' && can_complete_directly) { range.value = 100; out.textContent = '100%'; } };
      const send = async body => {
        try { await api(`/tasks/${t.id}/updates`, { method: 'POST', body: formData(body, f.querySelector('[name=files]')) }); toast(body.status === 'completed' && t.status !== 'completed' ? 'Task completed' : 'Update posted'); router(); }
        catch (err) { $('#updErr').textContent = err.message; }
      };
      f.onsubmit = e => {
        e.preventDefault();
        const fd = new FormData(f);
        const body = { message: fd.get('message') };
        if (fd.get('status') !== t.status) body.status = fd.get('status');
        if (+fd.get('progress') !== t.progress) body.progress = +fd.get('progress');
        if (!body.message.trim() && body.status === undefined && body.progress === undefined && !f.querySelector('[name=files]').files.length) { $('#updErr').textContent = 'Write an update, change the progress or attach a file.'; return; }
        send(body);
      };
      const md = $('#markDone'); if (md) md.onclick = () => send({ status: 'completed', message: f.querySelector('[name=message]').value });
    }
  }

  // ---------- projects ----------
  // Projects: team tabs show that team's projects (progress over that team's tasks); "All" shows every project grouped by
  // team (a project with two teams is listed under both), "No team" last. Managers/admins set a project's teams.
  async function viewProjects() {
    const { q, go } = pageQuery('projects');
    const { teams } = await api('/teams');
    const tabs = teamTabsFor(teams), landing = isLanding('projects', q, tabs), cur = landing ? 'all' : currentTeamTab(q, teams, tabs);
    const { projects } = landing && !q.get('q') ? { projects: [] } : await api('/projects' + (cur !== 'all' ? '?team=' + encodeURIComponent(cur) : ''));
    const teamChips = p => p.teams.length ? `<div class="team-chips">${p.teams.map(t => `<span class="pill">${esc(t.name)}</span>`).join('')}</div>` : '';
    const table = list => `<div class="card table-wrap"><table>
        <thead><tr><th>Project</th><th>Status</th><th class="n">Assigned</th><th class="n">Completed</th><th style="min-width:140px">Progress</th>${isBoss() ? '<th></th>' : ''}</tr></thead>
        <tbody>${list.map(p => `<tr>
          <td><a href="#/tasks?project=${p.id}${/^\d+$/.test(cur) ? '&team=' + cur : '&team=all'}">${esc(p.name)}</a>${p.description ? `<div class="muted" style="font-size:.8125rem">${esc(p.description)}</div>` : ''}${teamChips(p)}</td>
          <td>${PSTATUS[p.status]}</td><td class="n">${p.total}</td><td class="n">${p.completed}</td>
          <td>${bar(p.total, p.completed)}<div class="num" style="margin-top:4px">${p.total ? Math.round(p.completed / p.total * 100) : 0}%</div></td>
          ${isBoss() ? `<td><button class="btn ghost small" data-edit="${p.id}">Edit</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
    if (landing) {
      const text = (q.get('q') || '').toLowerCase(), found = projects.filter(p => (p.name + ' ' + (p.description || '')).toLowerCase().includes(text));
      return renderLanding({ page: 'projects', title: 'Projects', tabs, q, go,
        sub: 'Progress counts completed tasks against all tasks. Choose a team, or open all teams.', placeholder: 'Search projects in all your teams',
        actions: isBoss() ? `<button class="btn" id="newProj">New project</button>` : '',
        body: c => `<p class="block-stats">${stat(c.projects, c.projects === 1 ? 'project' : 'projects')}${stat(c.total, 'tasks')}</p>${bar(c.total, c.completed)}<div class="num" style="margin-top:4px">${c.total ? Math.round(c.completed / c.total * 100) : 0}% completed</div>`,
        results: found.length ? table(found) : '<div class="card empty">No projects match.</div>'
      }).then(() => { wireProjectButtons(); });
    }
    let body;
    if (!projects.length) body = `<div class="card empty">${cur !== 'all' ? 'No projects for this team yet.' : isBoss() ? 'No projects yet. Create one to group related tasks.' : 'No projects yet.'}</div>`;
    else if (cur === 'all' && tabs.length) {
      // One row per (project, team); projects without a team go to "No team".
      const pairs = projects.flatMap(p => p.teams.length ? p.teams.map(t => ({ p, id: t.id, name: t.name })) : [{ p, id: null }]);
      body = byTeam(pairs, x => x.id, x => x.name, tabs).map(g => groupHtml('projects:' + g.id, g.name,
        `(${g.rows.length} project${g.rows.length === 1 ? '' : 's'})`, table(g.rows.map(x => x.p)))).join('');
    } else body = table(projects);
    app.innerHTML = `
      <div class="page-head"><div><h1>Projects</h1><p>Progress counts completed tasks against all tasks in each project${/^\d+$/.test(cur) ? ' (this team’s tasks only)' : ''}.</p></div>
        ${isBoss() ? `<button class="btn" id="newProj">New project</button>` : ''}</div>
      ${teamHeaderHtml('projects', tabs, cur)}
      ${body}`;
    wireTabs(go); wireGroups(); wireProjectButtons();
    function wireProjectButtons() {
      const nb = $('#newProj'); if (nb) nb.onclick = () => form();
      app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(projects.find(p => p.id === +b.dataset.edit)));
    }
    function form(p) {
      const picks = teams.map(t => ({ id: t.id, name: t.name }));
      openModal(`
      <h2 style="font-size:1.25rem">${p ? 'Edit project' : 'New project'}</h2>
      <label class="f"><span>Name</span><input name="name" required maxlength="160" value="${esc(p?.name)}"></label>
      <label class="f"><span>Description</span><textarea name="description">${esc(p?.description)}</textarea></label>
      ${p ? `<label class="f"><span>Status</span><select name="status">${options(PSTATUS, p.status)}</select></label>` : ''}
      ${pickerHtml('Teams', 'Type a team name. The project shows on these teams’ tabs; leave empty for “No team”.').replace('Type a name…', 'Type a team…')}
      ${modalActions(p ? 'Save changes' : 'Create project')}`,
      async fd => {
        const body = Object.fromEntries(fd);
        if (!body.name.trim()) throw new Error('Enter a project name.');
        body.team_ids = picker.values();
        await api(p ? '/projects/' + p.id : '/projects', { method: p ? 'PATCH' : 'POST', body });
        toast(p ? 'Project updated' : 'Project created'); router();
      });
      const picker = personPicker(modalForm.querySelector('.picker'), picks, { selected: p ? picks.filter(t => p.teams.some(x => x.id === t.id)) : [] });
    }
  }

  // ---------- people (managers/admins: Teams page → "All people", and Edit on a team's member rows) ----------
  // "Lead of <team>" next to the role; a team lead who leads no team gets a warning.
  function roleCell(u, teams) {
    const led = teams.filter(t => t.leads.some(l => l.id === u.id));
    if (led.length) return `${ROLE[u.role]}<div class="muted" style="font-size:.8125rem">Lead of ${led.map(t => `<a href="#/teams/${t.id}">${esc(t.name)}</a>`).join(', ')}</div>`;
    if (u.role === 'lead' && u.active) return `${ROLE[u.role]}<div class="warn-text" style="margin:2px 0 0;font-size:.8125rem">⚠ Not leading a team yet – set it on the <a href="#/teams">Teams page</a></div>`;
    return ROLE[u.role];
  }
  // Add or edit a person (name, email, role, team, password, active). The server keeps the admin-only rules.
  // New people get a welcome email with a "Set your password" link when email is set up; a typed password is the fallback.
  async function personForm(u, teams) {
    const emailOn = (await api('/me/email-prefs').catch(() => ({}))).email_enabled;
    const roles = me.role === 'admin' ? ROLE : { manager: 'Manager', lead: 'Team lead', employee: 'Employee' };
    openModal(`
      <h2 style="font-size:1.25rem">${u ? 'Edit ' + esc(u.name) : 'Add a person'}</h2>
      <div class="grid2">
        <label class="f"><span>Full name</span><input name="name" required value="${esc(u?.name)}"></label>
        <label class="f"><span>Email</span><input name="email" type="email" required value="${esc(u?.email)}"></label>
        <label class="f"><span>Role</span><select name="role">${options(roles, u?.role || 'employee')}</select></label>
        <label class="f"><span>Team</span><select name="team_id"><option value="">No team</option>
          ${teams.map(t => `<option value="${t.id}"${u && t.id === u.team_id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      </div>
      ${!u && emailOn ? `<label class="check-row"><input type="checkbox" name="send_welcome" id="sendWelcome" checked> Send a welcome email with a “Set your password” link (valid 48 hours)</label>` : ''}
      <label class="f" id="pwField"${!u && emailOn ? ' hidden' : ''}><span>${u ? 'New password (leave empty to keep current)' : 'Temporary password'}</span><input name="password" type="text" minlength="8" autocomplete="new-password" ${u || emailOn ? '' : 'required'}></label>
      ${u && emailOn && u.active && !u.removed && canEditPerson(u) ? `<p style="margin:-6px 0 12px;font-size:.875rem"><button type="button" class="btn ghost small" id="resendWelcome">Resend welcome email</button> <span class="muted">A new “Set your password” link to ${esc(u.email)}; earlier links stop working.</span></p>` : ''}
      ${u && u.id !== me.id ? `<label class="f" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" style="width:auto" ${u.active ? 'checked' : ''}> Account active</label>` : ''}
      <p class="muted" style="font-size:.8125rem;margin-top:-4px">A team’s leads can assign tasks to the people in that team.</p>
      <div class="modal-actions">${canRemovePerson(u) ? '<button type="button" class="btn danger" id="removePersonBtn" style="margin-right:auto">Remove person</button>' : ''}
        <button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn" type="submit">${u ? 'Save changes' : 'Add person'}</button></div>`,
      async fd => {
        const body = Object.fromEntries(fd);
        if (u && u.id !== me.id) body.active = fd.get('active') === 'on';
        if (u && !body.password) delete body.password;
        if (!u && emailOn) { body.send_welcome = fd.get('send_welcome') === 'on'; if (body.send_welcome) delete body.password; }
        const r = await api(u ? '/users/' + u.id : '/users', { method: u ? 'PATCH' : 'POST', body });
        const lead = r.became_lead ? `${r.became_lead.name} is now a lead of ${r.became_lead.team_name}.` : '';
        toast(u ? lead || 'Changes saved' : [`${body.name} added.`, lead, r.welcome_sent ? `Welcome email sent to ${body.email}.` : 'Share their email and temporary password with them.'].filter(Boolean).join(' ')); router();
      });
    const sw = $('#sendWelcome');
    if (sw) sw.onchange = () => { $('#pwField').hidden = sw.checked; $('#pwField input').required = !sw.checked; };
    const rw = $('#resendWelcome');
    if (rw) rw.onclick = async () => {
      if (!confirm(`Send ${u.name} a new welcome email with a “Set your password” link? Earlier links stop working.`)) return;
      rw.disabled = true;
      try { const r = await api(`/users/${u.id}/welcome`, { method: 'POST' }); toast(`Welcome email sent to ${r.email}`); }
      catch (err) { $('#mErr').textContent = err.message; } finally { rw.disabled = false; }
    };
    const rb = $('#removePersonBtn'); if (rb) rb.onclick = () => { modal.close(); removePerson(u); };
  }
  // Admins only, never their own account (the server enforces both).
  const canRemovePerson = u => !!u && me.role === 'admin' && u.id !== me.id && !u.removed;
  // "Remove person": the server counts their records first. None → the account is deleted; otherwise it is kept for
  // History, marked "(removed)", signed out, taken out of teams, lead roles and group/team chats, and its email freed.
  async function removePerson(u) {
    let r;
    try { r = await api(`/users/${u.id}/removal`); } catch (e) { toast(e.message); return; }
    const list = Object.values(r.counts).filter(c => c.n);
    const leads = r.leads.length ? `lead of ${r.leads.map(l => esc(l.name)).join(', ')}` : '';
    openModal(`<h2 style="font-size:1.25rem">Remove ${esc(u.name)}?</h2>
      ${r.mode === 'delete'
        ? `<p>${esc(u.name)} has no tasks, approvals, requests, updates, files or chat messages. <b>Their account will be deleted completely</b>, with their sign-ins and chat memberships${leads ? ` (and their role as ${leads})` : ''}.</p>`
        : `<p>${esc(u.name)} has:</p><ul class="remove-counts">${list.map(c => `<li><b>${c.n}</b> ${esc(c.label)}</li>`).join('')}${leads ? `<li>${leads}</li>` : ''}</ul>
          <p>To keep History complete, <b>their account stays but is marked removed</b>: they are signed out and can’t sign in, they leave ${[u.team_name ? 'their team (' + esc(u.team_name) + ')' : '', leads ? 'their lead roles' : '', 'group and team chats'].filter(Boolean).join(', ')}, and they are shown as “${esc(u.name)} (removed)” wherever their name appears. Their email <b>${esc(u.email)}</b> becomes free for a new account. An admin can restore them later from All people → Removed.</p>`}
      <div class="modal-actions"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn danger-solid" type="submit">Remove person</button></div>`, async () => {
      const x = await api('/users/' + u.id, { method: 'DELETE' });
      toast(x.mode === 'deleted' ? `${u.name} was deleted` : `${u.name} was removed (kept in History)`); router();
    });
  }
  async function restorePerson(u) {
    if (!confirm(`Restore ${u.name.replace(/ \(removed\)$/, '')}? They can sign in again with their original email and password. Their team and team-lead roles are not given back – set them again on the Teams page.`)) return;
    try { await api(`/users/${u.id}/restore`, { method: 'POST' }); toast('Restored. Add them to a team again if needed.'); router(); } catch (e) { toast(e.message); }
  }
  const canEditPerson = u => !(u.role === 'admin' && me.role !== 'admin');
  // The view switch at the top of the Teams page (managers/admins only).
  const teamsViewSwitch = people => isBoss() ? `<div class="seg" role="group" aria-label="View">
      <a href="#/teams" aria-pressed="${!people}">Teams</a><a href="#/teams?view=people" aria-pressed="${people}">All people</a></div>` : '';
  // "All people" (the former People page): everyone, including people without a team and deactivated accounts.
  async function viewAllPeople() {
    const { q, go } = pageQuery('teams');
    const team = q.get('team') || '', role = q.get('role') || '', status = q.get('status') || '', text = (q.get('q') || '').toLowerCase();
    // Removed people only appear with the "Removed" status filter.
    const [{ users }, { teams }] = await Promise.all([api('/users' + (status === 'removed' ? '?removed=1' : '')), api('/teams')]);
    const byId = Object.fromEntries(users.map(u => [u.id, u]));
    const list = users.filter(u => (!team || (team === 'none' ? !u.team_id : String(u.team_id) === team))
      && (!role || u.role === role) && (status === 'removed' ? u.removed : !u.removed && (!status || (status === 'active' ? u.active : !u.active)))
      && (!text || u.name.toLowerCase().includes(text) || u.email.toLowerCase().includes(text)));
    app.innerHTML = `
      <div class="page-head"><div><h1>All people</h1><p>${list.length} of ${users.length} people. Add people and choose their team. A team lead added to a team becomes one of its leads.</p></div>
        <div class="inline-actions">${teamsViewSwitch(true)}<button class="btn" id="newUser">Add a person</button></div></div>
      <div class="filters">
        <input type="search" id="pSearch" class="search" placeholder="Search name or email" aria-label="Search people" value="${esc(q.get('q') || '')}">
        <select id="pTeam" aria-label="Filter by team"><option value="">All teams</option><option value="none"${team === 'none' ? ' selected' : ''}>No team</option>
          ${teams.map(t => `<option value="${t.id}"${String(t.id) === team ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <select id="pRole" aria-label="Filter by role"><option value="">All roles</option>${options(ROLE, role)}</select>
        <select id="pStatus" aria-label="Filter by status"><option value="">Active and deactivated</option>
          <option value="active"${status === 'active' ? ' selected' : ''}>Active</option><option value="inactive"${status === 'inactive' ? ' selected' : ''}>Deactivated</option><option value="removed"${status === 'removed' ? ' selected' : ''}>Removed</option></select>
      </div>
      ${list.length ? `<div class="card table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map(u => `<tr>
          <td><a href="#/tasks?assignee=${u.id}&team=all">${esc(u.name)}</a></td><td>${esc(u.email)}</td><td>${roleCell(u, teams)}</td>
          <td>${u.team_name ? `<a href="#/teams/${u.team_id}">${esc(u.team_name)}</a>` : '<span class="muted">No team</span>'}</td>
          <td>${u.removed ? '<span class="muted">Removed</span>' : u.active ? 'Active' : '<span class="muted">Deactivated</span>'}</td>
          <td><div class="inline-actions">${u.removed ? (me.role === 'admin' ? `<button class="btn ghost small" data-restore="${u.id}">Restore</button>` : '')
            : `${canEditPerson(u) ? `<button class="btn ghost small" data-edit="${u.id}">Edit</button>` : ''}${canRemovePerson(u) ? `<button class="btn danger small" data-removep="${u.id}">Remove person</button>` : ''}`}</div></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="card empty">Nobody matches these filters.</div>'}`;
    wireSearch('pSearch', go);
    $('#pTeam').onchange = e => go({ team: e.target.value });
    $('#pRole').onchange = e => go({ role: e.target.value });
    $('#pStatus').onchange = e => go({ status: e.target.value });
    $('#newUser').onclick = () => personForm(null, teams);
    app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => personForm(byId[b.dataset.edit], teams));
    app.querySelectorAll('[data-removep]').forEach(b => b.onclick = () => removePerson(byId[b.dataset.removep]));
    app.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => restorePerson(byId[b.dataset.restore]));
  }

  // ---------- teams (everyone: company directory; managers and admins manage them) ----------
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  async function viewTeams() {
    if (new URLSearchParams(location.hash.split('?')[1] || '').get('view') === 'people' && isBoss()) return viewAllPeople();
    const { teams } = await api('/teams');
    teams.sort((a, b) => b.mine - a.mine); // your own team first (the server sorts by name)
    app.innerHTML = `
      <div class="page-head"><div><h1>Teams</h1><p>Every team and who is in it. A team’s leads assign its work and its incoming document requests.</p></div>
        ${isBoss() ? `<div class="inline-actions">${teamsViewSwitch(false)}<button class="btn" id="newTeam">Add a team</button></div>` : ''}</div>
      ${teams.length ? `<div class="team-grid">${teams.map(t => `<a class="card team-card${t.mine ? ' mine' : ''}" href="#/teams/${t.id}">
        <div class="row-top"><h2>${esc(t.name)}</h2>${t.mine ? '<span class="pill accent">Your team</span>' : ''}</div>
        <p class="${t.leads.length ? '' : isBoss() ? 'warn-text' : 'muted'}">${t.leads.length ? (t.leads.length === 1 ? 'Lead: ' : 'Leads: ') + esc(t.leads.map(l => l.name).join(', ')) : isBoss() ? '⚠ No lead' : 'No lead yet'}</p>
        <p class="muted">${plural(t.member_count, 'active member')}</p>
        ${t.connections.length ? `<p class="muted">Works with: ${esc(t.connections.map(c => c.name).join(', '))}</p>` : ''}
        ${t.can_see_counts ? `<p class="team-counts"><span><b>${t.open_tasks}</b> open task${t.open_tasks === 1 ? '' : 's'}</span><span><b>${t.open_requests}</b> open request${t.open_requests === 1 ? '' : 's'}</span></p>` : ''}
      </a>`).join('')}</div>` : '<div class="card empty">No teams yet.</div>'}`;
    if (isBoss()) $('#newTeam').onclick = () => teamNameForm();
  }
  // Add a team / rename a team (managers and admins).
  function teamNameForm(t) {
    openModal(`<h2 style="font-size:1.25rem">${t ? 'Rename ' + esc(t.name) : 'Add a team'}</h2>
      <label class="f"><span>Team name</span><input name="name" required maxlength="120" value="${esc(t?.name)}"></label>
      ${t ? '' : '<p class="muted" style="font-size:.8125rem;margin-top:-4px">Then open the team to add members and choose its leads.</p>'}
      ${modalActions(t ? 'Save' : 'Add team')}`, async fd => {
      const name = String(fd.get('name')).trim();
      if (!name) throw new Error('Enter a team name.');
      const r = await api(t ? '/teams/' + t.id : '/teams', { method: t ? 'PATCH' : 'POST', body: { name } });
      toast(t ? 'Team renamed' : 'Team added'); if (t) router(); else location.hash = '#/teams/' + r.team.id;
    });
  }

  async function viewTeam(id) {
    const [d, { users }, { teams }] = await Promise.all([api('/teams/' + id), isBoss() ? api('/users') : { users: [] }, isBoss() ? api('/teams') : { teams: [] }]);
    const t = d.team;
    const counts = d.team.can_see_counts;
    app.innerHTML = `
      <p style="margin:0 0 10px"><a href="#/teams">← All teams</a></p>
      <div class="page-head"><div><h1>${esc(t.name)}</h1><p>${t.mine ? 'Your team · ' : ''}${plural(t.member_count, 'active member')}${counts ? ` · ${plural(t.open_tasks, 'open task')} · ${plural(t.open_requests, 'open request')}` : ''}</p></div>
        ${d.can_manage ? `<div class="inline-actions"><button class="btn" id="addMember">Add member</button><button class="btn ghost" id="setLead">Leads</button>
          <button class="btn ghost" id="renameTeam">Rename</button><button class="btn danger" id="delTeam">Delete</button></div>` : ''}</div>
      <section class="card" style="margin-bottom:20px"><h2>${d.leads.length > 1 ? 'Leads' : 'Lead'}</h2>
        ${d.leads.length ? `<ul class="rows">${d.leads.map(l => `<li><b>${esc(l.name)}</b> <span class="muted">${ROLE[l.role]} · ${esc(l.email)}${l.member ? '' : ' · not a member of this team'}</span></li>`).join('')}</ul>
          ${d.leads.length > 1 ? '<p class="muted" style="margin:8px 0 0;font-size:.8125rem">All leads are equal: any of them can assign this team’s work and requests and approve it.</p>' : ''}`
          : `<p class="${d.can_manage ? 'warn-text' : 'muted'}" style="margin:0">${d.can_manage ? '⚠ This team has no lead. Its document requests can only be assigned and approved by a manager. Use “Leads”.' : 'This team has no lead yet.'}</p>`}
      </section>
      <section class="card" style="margin-bottom:20px"><h2>Connected teams</h2>
        <p class="muted" style="margin-top:0">Members of connected teams can send document requests to each other.${d.can_manage ? ' Managers set this; it works both ways.' : ''}</p>
        ${d.can_manage ? '<ul class="checks" id="connChecks"><li class="muted">Loading…</li></ul>'
          : t.connections.length ? `<p style="margin:0">${t.connections.map(c => `<a href="#/teams/${c.id}">${esc(c.name)}</a>`).join(', ')}</p>` : '<p class="muted" style="margin:0">None yet.</p>'}
      </section>
      <section class="card table-wrap"><h2>Members</h2>
        ${d.members.length ? `<table><thead><tr><th>Name</th><th>Role</th><th>Email</th>${counts ? '<th class="n">Open tasks</th>' : ''}${d.can_assign || d.can_manage ? '<th></th>' : ''}</tr></thead>
          <tbody>${d.members.map(m => `<tr>
            <td>${esc(m.name)}${m.is_lead ? ' <span class="pill accent">Lead</span>' : ''}${m.active ? '' : ' <span class="muted">· deactivated</span>'}</td>
            <td>${ROLE[m.role]}</td><td>${esc(m.email)}</td>
            ${counts ? `<td class="n"><a href="#/tasks?assignee=${m.id}&status=open">${m.open_tasks}</a></td>` : ''}
            ${d.can_assign || d.can_manage ? `<td><div class="inline-actions">
              ${d.can_assign && m.active ? `<button class="btn ghost small" data-assign="${m.id}">Assign a task</button>` : ''}
              ${d.can_manage && canEditPerson(m) ? `<button class="btn ghost small" data-editp="${m.id}">Edit</button>` : ''}
              ${d.can_manage && !(m.role === 'admin' && me.role !== 'admin') ? `<button class="btn ghost small" data-remove="${m.id}">Remove</button>` : ''}</div></td>` : ''}
          </tr>`).join('')}</tbody></table>` : `<p class="muted">No members yet.${d.can_manage ? ' Use “Add member”.' : ''}</p>`}
      </section>`;
    app.querySelectorAll('[data-assign]').forEach(b => b.onclick = () => taskForm(null, { preset: Number(b.dataset.assign) }));
    if (!d.can_manage) return;
    const others = teams.filter(x => x.id !== t.id), linked = new Set(t.connections.map(c => c.id));
    $('#connChecks').innerHTML = others.length ? others.map(x => `<li><label><input type="checkbox" value="${x.id}"${linked.has(x.id) ? ' checked' : ''}> ${esc(x.name)}</label></li>`).join('')
      : '<li class="muted">There are no other teams yet.</li>';
    $('#connChecks').onchange = async () => {
      const ids = [...$('#connChecks').querySelectorAll('input:checked')].map(i => Number(i.value));
      try { await api(`/teams/${t.id}/connections`, { method: 'PUT', body: { team_ids: ids } }); toast('Connected teams saved'); }
      catch (e) { toast(e.message); router(); }
    };
    app.querySelectorAll('[data-editp]').forEach(b => b.onclick = () => personForm(users.find(u => u.id === Number(b.dataset.editp)), teams));
    const leadToast = r => toast(r && r.became_lead ? `${r.became_lead.name} is now a lead of ${r.became_lead.team_name}` : 'Added to the team');
    app.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
      const m = d.members.find(x => x.id === Number(b.dataset.remove));
      if (!confirm(`Remove ${m.name} from ${t.name}?${m.is_lead ? ' They stay one of its leads until you change the leads.' : ''}`)) return;
      try { await api(`/teams/${t.id}/members/${m.id}`, { method: 'DELETE' }); toast('Removed from the team'); router(); } catch (e) { toast(e.message); }
    });
    $('#renameTeam').onclick = () => teamNameForm(t);
    $('#delTeam').onclick = async () => {
      if (!confirm(`Delete the team “${t.name}”? Its members will have no team.`)) return;
      try { await api('/teams/' + t.id, { method: 'DELETE' }); toast('Team deleted'); location.hash = '#/teams'; } catch (e) { toast(e.message); }
    };
    $('#addMember').onclick = () => {
      const people = users.filter(u => u.active && u.team_id !== t.id && !(u.role === 'admin' && me.role !== 'admin'))
        .map(u => ({ ...u, team_name: u.team_name ? 'now in ' + u.team_name : 'no team' }));
      openModal(`<h2 style="font-size:1.25rem">Add a member to ${esc(t.name)}</h2>
        ${pickerHtml('Person', 'Someone already in another team moves to this one. A team lead added to the team becomes one of its leads.')}
        ${modalActions('Add member')}`, async () => {
        const [uid] = picker.values();
        if (!uid) throw new Error('Choose a person.');
        leadToast(await api(`/teams/${t.id}/members/${uid}`, { method: 'PUT' })); router();
      });
      const picker = personPicker(modalForm.querySelector('.picker'), people, { multiple: false });
    };
    // Leads (several, all equal): active team leads, managers and admins; say if they already lead another team.
    $('#setLead').onclick = () => {
      const leading = id => teams.filter(x => x.id !== t.id && x.leads.some(l => l.id === id)).map(x => x.name);
      const people = users.filter(u => u.active && u.role !== 'employee').map(u => {
        const o = leading(u.id);
        return { ...u, team_name: [u.team_name, o.length ? 'already leads ' + o.join(', ') : ''].filter(Boolean).join(' · ') };
      });
      openModal(`<h2 style="font-size:1.25rem">Leads of ${esc(t.name)}</h2>
        ${pickerHtml('Leads', 'All leads are equal. Only active team leads, managers and admins can lead a team; change someone’s role on the People page.')}
        ${modalActions('Save leads')}`, async () => {
        const r = await api(`/teams/${t.id}/leads`, { method: 'PUT', body: { user_ids: picker.values() } });
        toast(r.leads.length ? 'Leads saved' : 'This team has no lead now'); router();
      });
      const picker = personPicker(modalForm.querySelector('.picker'), people, { selected: people.filter(p => d.leads.some(l => l.id === p.id)) });
    };
  }

  // ---------- document requests ----------
  // Requests: team tabs; on a team, "Incoming" (sent to the team) and "Sent" (made by its members); "All" is grouped by
  // the team each request was sent to. Status filter and search as well; everything in the URL.
  async function viewRequests() {
    const { q, go } = pageQuery('requests');
    const { teams } = await api('/teams');
    const tabs = teamTabsFor(teams), landing = isLanding('requests', q, tabs), cur = landing ? 'all' : currentTeamTab(q, teams, tabs);
    const sent = q.get('dir') === 'out';
    const params = new URLSearchParams();
    for (const k of ['status', 'q']) if (q.get(k)) params.set(k, q.get(k));
    if (cur !== 'all') params.set(sent ? 'from_team' : 'team', cur);
    const { requests } = landing && !q.get('q') ? { requests: [] } : await api('/requests?' + params);
    const table = list => `<div class="card table-wrap"><table>
        <thead><tr><th>Title</th><th>Requested by</th><th>${sent ? 'Sent to' : 'For team'}</th><th>Needed by</th><th>Status</th><th>Taken by</th></tr></thead>
        <tbody>${list.map(r => `<tr><td><a href="#/requests/${r.id}">${esc(r.title)}</a></td>
          <td>${esc(r.requested_by_name)}${cur === 'all' || sent || !r.requester_team_name || String(r.requester_team_id) === cur ? '' : ` <span class="muted">· ${esc(r.requester_team_name)}</span>`}</td>
          <td>${r.team_name ? esc(r.team_name) : r.status === 'needs_team' ? '<span class="muted">Not decided yet</span>' : '<span class="muted">—</span>'}</td><td>${fmtDate(r.needed_by)}</td><td>${reqPill(r)}</td>
          <td>${r.assignee_name ? esc(r.assignee_name) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    const open = list => list.filter(r => ['needs_team', 'open'].includes(r.status)).length;
    if (landing) return renderLanding({ page: 'requests', title: 'Document requests', tabs, q, go,
      sub: 'Ask another team for a document. Choose a team to see what it was asked for and what it sent, or open all teams.',
      placeholder: 'Search requests in all your teams', actions: '<button class="btn" id="newReq">New request</button>',
      body: c => `<p class="block-stats">${stat(c.incoming, 'incoming, waiting for someone', c.incoming ? 'warn' : '')}${stat(c.sent, 'sent, not finished')}${stat(c.delivered_week, 'delivered in 7 days')}</p>`,
      results: requests.length ? table(requests) : '<div class="card empty">No requests match.</div>'
    }).then(() => { $('#newReq').onclick = () => requestForm(); });
    const body = !requests.length ? `<div class="card empty">${q.get('status') || q.get('q') ? 'No requests match these filters.' : cur === 'all' ? 'No document requests yet.' : sent ? 'This team hasn’t sent any requests.' : 'No requests for this team.'}</div>`
      : cur === 'all' && tabs.length ? byTeam(requests, r => r.target_team_id, r => r.team_name, tabs, 'Not decided yet').map(g =>
          groupHtml('requests:' + g.id, g.name, `(${g.rows.length}) · ${open(g.rows)} waiting for someone`, table(g.rows))).join('')
      : table(requests);
    app.innerHTML = `
      <div class="page-head"><div><h1>Document requests</h1><p>Ask another team for a document. A member of that team takes it on, and you’re told when it’s ready.</p></div>
        <button class="btn" id="newReq">New request</button></div>
      ${teamHeaderHtml('requests', tabs, cur)}
      ${cur !== 'all' ? `<div class="seg sub-tabs" role="group" aria-label="Direction"><button type="button" data-dir="" aria-pressed="${!sent}">Incoming</button><button type="button" data-dir="out" aria-pressed="${sent}">Sent</button></div>` : ''}
      <div class="filters">
        <input type="search" id="rSearch" class="search" placeholder="Search title or details" aria-label="Search requests" value="${esc(q.get('q') || '')}">
        <select id="fStatus" aria-label="Filter by status"><option value="">All statuses</option>
          <option value="active"${q.get('status') === 'active' ? ' selected' : ''}>Not finished</option>${options(RSTATUS, q.get('status'))}</select>
      </div>
      ${body}`;
    wireTabs(go); wireGroups(); wireSearch('rSearch', go);
    app.querySelectorAll('[data-dir]').forEach(b => b.onclick = () => go({ dir: b.dataset.dir }));
    $('#fStatus').onchange = e => go({ status: e.target.value });
    $('#newReq').onclick = () => requestForm();
  }
  // New request: to a team (own team and connected teams; managers/admins: any) or straight to a person in those teams.
  async function requestForm() {
    const { teams: targets, people } = await api('/request-targets');
    openModal(`
      <h2 style="font-size:1.25rem">New document request</h2>
      <label class="f"><span>What do you need?</span><input name="title" required maxlength="200"></label>
      <label class="f"><span>Details</span><textarea name="description" placeholder="What the document should contain, format, who it is for"></textarea></label>
      <fieldset class="choice"><legend>Send to</legend>
        <label><input type="radio" name="send_to" value="team" checked> A team</label>
        <label><input type="radio" name="send_to" value="person"${people.length ? '' : ' disabled'}> A person</label></fieldset>
      <div id="toTeam"><label class="f"><span>Which team?</span><select name="target_team_id"><option value="">Choose a team</option>
          ${targets.map(t => `<option value="${t.id}">${esc(t.name)}${t.id === me.team_id ? ' (your team)' : ''}</option>`).join('')}<option value="none">Not sure, let a manager decide</option></select>
        <small class="muted">${isBoss() ? 'Any team.' : me.team_id ? 'Your team and the teams it works with. For another team, choose “Not sure” and a manager will send it on.' : 'You aren’t in a team yet, so a manager will choose the team.'}</small></label></div>
      <div id="toPerson" hidden>${pickerHtml('Person', isBoss() ? 'Anyone in a team. They get it as a task straight away.' : 'People in your team and in the teams it works with. They get it as a task straight away.')}</div>
      <label class="f"><span>Needed by</span><input type="date" name="needed_by"></label>
      ${fileInput()}
      ${modalActions('Post request')}`, async fd => {
        const body = Object.fromEntries([...fd].filter(([k]) => !['files', 'send_to'].includes(k)));
        if (!body.title.trim()) throw new Error('Enter what you need.');
        if (fd.get('send_to') === 'person') {
          const [person] = picker.people();
          if (!person) throw new Error('Choose a person.');
          delete body.target_team_id; body.person_id = person.id;
        } else if (!body.target_team_id) throw new Error('Choose a team, or “Not sure, let a manager decide”.');
        const r = await api('/requests', { method: 'POST', body: formData(body, modalForm.querySelector('[name=files]')) });
        toast(body.person_id ? 'Sent to ' + picker.people()[0].name : 'Request posted'); location.hash = '#/requests/' + r.request.id;
      });
    const picker = personPicker(modalForm.querySelector('.picker'), people, { multiple: false });
    modalForm.querySelectorAll('[name=send_to]').forEach(rb => rb.onchange = () => {
      const person = modalForm.querySelector('[name=send_to]:checked').value === 'person';
      $('#toTeam').hidden = person; $('#toPerson').hidden = !person;
    });
  }

  // "Assign to" for an open request (request page and the dashboard's "Requests to assign"): one person, type to search.
  // The team's leads see its active members; managers/admins see everyone, the request's team first (server order).
  // The current user comes first as "<name> (me)" when they may take it; choosing it is the same as "Take this task".
  const assignable = d => {
    const team = m => m.team_id === d.request.target_team_id ? `${m.team_name} (this request’s team)` : m.team_name || 'No team';
    const others = d.members.filter(m => m.id !== me.id).map(m => ({ ...m, team_name: team(m) }));
    const mine = me.team_id !== d.request.target_team_id && d.i_lead ? `Lead of ${d.request.team_name}` : team(me);
    return d.can_take && !d.take_blocked ? [{ ...me, name: me.name + ' (me)', team_name: mine }, ...others] : others;
  };
  const noOthers = d => `No other members in ${esc(d.request.team_name)} yet – add them on the <a href="#/teams/${d.request.target_team_id}">Teams page</a>.`;
  const assignHint = d => assignable(d).some(m => m.id !== me.id) ? (isBoss() ? 'Anyone can be chosen; people in the request’s team are listed first.'
    : `Active members of ${esc(d.request.team_name)}.`) : noOthers(d);
  function assignPickerHtml(d) {
    if (!assignable(d).length) return `<p class="muted" style="margin:0">${noOthers(d)}</p>`;
    return `${pickerHtml('Person', assignHint(d))}<p class="err" id="assignErr"></p><button class="btn">Assign</button>`;
  }
  // Assign the request, or take it when the current user chose themself (then open their new task).
  async function assignTo(d, person) {
    if (person.id === me.id) {
      const x = await api(`/requests/${d.request.id}/take`, { method: 'POST' });
      toast('The task is yours'); location.hash = '#/tasks/' + x.task_id; return;
    }
    await api(`/requests/${d.request.id}/assign`, { method: 'POST', body: { user_id: person.id } });
    toast('Assigned to ' + person.name); router();
  }
  function assignPicker(form, d) {
    const people = assignable(d);
    return people.length ? personPicker(form.querySelector('.picker'), people, { multiple: false }) : null;
  }
  // Dashboard: open the same picker in a dialog.
  async function assignRequestModal(id) {
    const d = await api('/requests/' + id);
    if (!d.can_assign) { toast('This request can’t be assigned any more.'); return router(); }
    openModal(`<h2 style="font-size:1.25rem">Assign “${esc(d.request.title)}”</h2>
      <p class="muted" style="margin-top:0">For ${esc(d.request.team_name)} · requested by ${esc(d.request.requested_by_name)} · needed by ${fmtDate(d.request.needed_by)}</p>
      ${assignable(d).length ? pickerHtml('Assign to', assignHint(d)) + modalActions('Assign')
        : assignPickerHtml(d) + '<div class="modal-actions"><button class="btn ghost" value="cancel" formnovalidate>Close</button></div>'}`, async () => {
      const [person] = picker ? picker.people() : [];
      if (!person) throw new Error('Choose a person.');
      await assignTo(d, person);
    });
    const picker = assignPicker(modalForm, d);
  }

  async function viewRequest(id) {
    const d = await api('/requests/' + id), r = d.request;
    app.innerHTML = `
      <p style="margin:0 0 10px"><a href="#/requests">← All requests</a></p>
      <div class="page-head"><div><h1>${esc(r.title)}</h1><p>${reqPill(r)} <span style="margin-left:6px">Needed by ${fmtDate(r.needed_by)}</span></p></div>
        <div class="inline-actions">
          ${d.can_take && !d.take_blocked ? `<button class="btn" id="takeBtn">Take this task</button>` : ''}
          ${d.can_receive ? `<button class="btn" id="recvBtn">Mark as received</button>` : ''}
          ${d.can_cancel ? `<button class="btn danger" id="cancelBtn">Cancel request</button>` : ''}
          ${d.can_withdraw ? `<button class="btn danger" id="withdrawBtn">Withdraw request</button>` : ''}
          ${d.can_delete ? `<button class="btn ghost" id="deleteReqBtn">Delete</button>` : ''}</div></div>
      ${d.take_blocked ? `<div class="card warn" style="margin-bottom:20px"><p style="margin:0">${esc(d.take_blocked)}</p></div>` : ''}
      ${r.status === 'needs_team' && !d.can_send_to_team ? `<div class="card" style="margin-bottom:20px"><p style="margin:0">No team was chosen for this request. A manager will send it to the right team.</p></div>` : ''}
      <div class="cols">
        <div class="stack">
          <section class="card">
            <dl class="meta-grid">
              <div><dt>Requested by</dt><dd>${esc(r.requested_by_name)}</dd></div>
              <div><dt>For team</dt><dd>${esc(r.team_name || (r.status === 'needs_team' ? 'Not decided yet' : '—'))}</dd></div>
              <div><dt>Posted</dt><dd>${fmtDate(r.created_at)}</dd></div>
              ${r.asked_person_name ? `<div><dt>Sent to</dt><dd>${esc(r.asked_person_name)}</dd></div>` : `<div><dt>Taken by</dt><dd>${esc(r.assignee_name || '—')}</dd></div>`}
              ${r.withdrawn_from_name ? `<div><dt>Withdrawn from</dt><dd>${esc(r.withdrawn_from_name)}</dd></div>` : ''}
              ${r.delivered_at ? `<div><dt>Delivered</dt><dd>${fmtDate(r.delivered_at)}</dd></div>` : ''}
              ${r.closed_at ? `<div><dt>${r.status === 'cancelled' ? 'Cancelled' : 'Received'}</dt><dd>${fmtDate(r.closed_at)}</dd></div>` : ''}
            </dl>
            <h2 style="margin-top:18px">Details</h2>
            <p class="desc">${r.description ? esc(r.description) : '<span class="muted">No details.</span>'}</p>
            ${d.files.length ? `<h2 style="margin-top:18px">Attachments</h2>${fileList(d.files)}` : ''}
            ${d.can_open_task && r.task_id ? `<p style="margin:14px 0 0"><a href="#/tasks/${r.task_id}">Open the linked task →</a></p>` : ''}
          </section>
          ${d.delivered_files.length || ['delivered', 'closed'].includes(r.status) && d.can_see_files ? `<section class="card"><h2>Delivered files</h2>
            ${d.delivered_files.length ? fileList(d.delivered_files) : '<p class="muted">No files were attached to the finished task.</p>'}</section>` : ''}
          ${d.events.length ? `<section class="card"><h2>Activity</h2><ul class="timeline">${d.events.map(e => `<li>
            <span class="who">${esc(e.user_name)}</span><span class="when">${fmtDateTime(e.created_at)}</span><p>${esc(e.message)}</p></li>`).join('')}</ul></section>` : ''}
          ${d.can_attach ? `<section class="card"><h2>Add attachments</h2><form id="attForm">${fileInput('Files')}<p class="err" id="attErr"></p><button class="btn ghost">Upload</button></form></section>` : ''}
        </div>
        ${d.can_send_to_team ? `<section class="card"><h2>Send to team</h2>
          <p class="muted" style="margin-top:0">The requester wasn’t sure which team should do this. Choose one; its members will be notified.</p>
          <ul class="rows">${d.teams.map(t => `<li class="row-top"><span>${esc(t.name)}${t.lead_count ? '' : ' <span class="muted">· no lead</span>'}</span>
            <button class="btn ghost small" data-sendteam="${t.id}">Send</button></li>`).join('')}</ul></section>` : ''}
        ${d.can_assign ? `<section class="card"><h2>Assign to</h2><form id="assignForm">${assignPickerHtml(d)}</form></section>` : ''}
      </div>`;
    const act = async (path, body, msg) => { try { await api(`/requests/${r.id}/${path}`, { method: 'POST', body }); toast(msg); router(); } catch (e) { toast(e.message); } };
    if ($('#takeBtn')) $('#takeBtn').onclick = async () => {
      try { const x = await api(`/requests/${r.id}/take`, { method: 'POST' }); toast('The task is yours'); location.hash = '#/tasks/' + x.task_id; } catch (e) { toast(e.message); }
    };
    if ($('#recvBtn')) $('#recvBtn').onclick = () => act('received', undefined, 'Request closed');
    if ($('#cancelBtn')) $('#cancelBtn').onclick = () => { if (confirm('Cancel this request?')) act('cancel', undefined, 'Request cancelled'); };
    if ($('#deleteReqBtn')) $('#deleteReqBtn').onclick = async () => {
      if (!confirm('Delete this request? It is kept in History, where a manager can restore it.')) return;
      try { await api('/requests/' + r.id, { method: 'DELETE' }); toast('Request deleted'); location.hash = '#/requests'; } catch (e) { toast(e.message); }
    };
    if ($('#withdrawBtn')) $('#withdrawBtn').onclick = () => {
      if (confirm(`Withdraw this request? ${r.assignee_name} will be told, and their task is removed (kept in History).`)) act('withdraw', undefined, 'Request withdrawn');
    };
    const asf = $('#assignForm');
    if (asf) {
      const picker = assignPicker(asf, d);
      if (picker) asf.onsubmit = e => {
        e.preventDefault();
        const [person] = picker.people();
        if (!person) { $('#assignErr').textContent = 'Choose a person.'; return; }
        assignTo(d, person).catch(err => { $('#assignErr').textContent = err.message; });
      };
    }
    app.querySelectorAll('[data-sendteam]').forEach(b => b.onclick = () => act('send-to-team', { team_id: Number(b.dataset.sendteam) }, 'Sent to the team'));
    const af = $('#attForm');
    if (af) af.onsubmit = async e => {
      e.preventDefault();
      const fi = af.querySelector('[name=files]');
      if (!fi.files.length) { $('#attErr').textContent = 'Choose at least one file.'; return; }
      try { await api(`/requests/${r.id}/files`, { method: 'POST', body: formData({}, fi) }); toast('Files added'); router(); }
      catch (err) { $('#attErr').textContent = err.message; }
    };
  }

  // ---------- history ----------
  async function viewHistory() {
    const { q, go } = pageQuery('history');
    const { teams } = await api('/teams');
    const tabs = teamTabsFor(teams), cur = currentTeamTab(q, teams, tabs);
    const params = new URLSearchParams();
    for (const k of ['person', 'status', 'from', 'to']) if (q.get(k)) params.set(k, q.get(k));
    if (cur !== 'all') params.set('team', cur); // the team tab (the CSV follows it too)
    const [{ rows }, { users }] = await Promise.all([api('/history?' + params), api('/users')]);
    const setQ = (k, v) => go({ [k]: v });
    const ALL = Object.assign({}, STATUS, { needs_team: 'Needs a team (request)', open: 'Open (request)', delivered: 'Delivered (request)', closed: 'Closed (request)', cancelled: 'Cancelled (request)', deleted: 'Deleted' });
    const d = v => v ? fmtDate(v) : '<span class="muted">—</span>';
    // Archived (deleted) items: "Deleted by <name> on <date>"; managers/admins can restore them or delete them permanently.
    const pill = r => r.status === 'deleted' ? `<span class="pill rq-cancelled">Deleted</span>
        <small class="muted deleted-note">Deleted by ${esc(r.deleted_by_name || 'unknown')} on ${fmtDate(r.deleted_at)}</small>
        ${isBoss() ? `<span class="inline-actions"><button class="btn ghost small" data-restore="${r.type}/${r.id}">Restore</button>
          <button class="btn danger small" data-purge="${r.type}/${r.id}">Delete permanently</button></span>` : ''}`
      : r.type === 'request' ? reqPill(r) : `<span class="pill st-${esc(r.status)}">${STATUS[r.status] || esc(r.status)}</span>`;
    app.innerHTML = `
      <div class="page-head"><div><h1>History</h1><p>${rows.length} item${rows.length === 1 ? '' : 's'}. ${isBoss() ? 'All tasks and requests.' : me.role === 'lead' ? 'Your teams’ tasks and requests, and anything you assigned.' : 'Your own tasks and the requests you made.'}</p></div>
        <a class="btn" id="csvBtn" href="/api/history?${new URLSearchParams([...params, ['format', 'csv']])}" download>Export to Excel</a></div>
      ${tabsHtml(tabs, cur)}
      <div class="filters">
        ${users.length > 1 ? `<select id="hPerson" aria-label="Filter by person"><option value="">Everyone</option>
          ${users.map(u => `<option value="${u.id}"${String(u.id) === q.get('person') ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
        <select id="hStatus" aria-label="Filter by status"><option value="">All statuses</option>${options(ALL, q.get('status'))}</select>
        <label class="inline-date">From <input type="date" id="hFrom" value="${esc(q.get('from') || '')}"></label>
        <label class="inline-date">To <input type="date" id="hTo" value="${esc(q.get('to') || '')}"></label>
      </div>
      ${rows.length ? `<div class="card table-wrap"><table class="history">
        <thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Team</th><th>Assigned to</th><th>Assigned by</th><th>Requested by</th>
          <th>Assigned</th><th>Submitted</th><th>Approved</th><th>Completed</th><th>Approved by</th><th>Send-back reasons</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${r.status === 'deleted' ? esc(r.title) : `<a href="#/${r.type === 'request' ? 'requests' : 'tasks'}/${r.id}">${esc(r.title)}</a>`}</td><td>${r.type === 'request' ? 'Request' : 'Task'}</td><td>${pill(r)}</td>
          <td>${esc(r.team_name || '—')}</td><td>${esc(r.assignee_name || '—')}</td><td>${esc(r.assigned_by_name || '—')}</td><td>${esc(r.requested_by_name || '—')}</td>
          <td>${d(r.assigned_at)}</td><td>${d(r.submitted_at)}</td><td>${d(r.approved_at)}</td><td>${d(r.completed_at)}</td>
          <td>${esc(r.approved_by_name || '—')}</td><td class="reasons">${esc(r.send_back_reasons || '')}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty">Nothing matches these filters.</div>`}`;
    if ($('#hPerson')) $('#hPerson').onchange = e => setQ('person', e.target.value);
    wireTabs(go);
    $('#hStatus').onchange = e => setQ('status', e.target.value);
    $('#hFrom').onchange = e => setQ('from', e.target.value);
    $('#hTo').onchange = e => setQ('to', e.target.value);
    const path = v => { const [type, id] = v.split('/'); return `/${type === 'request' ? 'requests' : 'tasks'}/${id}`; };
    const title = v => rows.find(r => `${r.type}/${r.id}` === v).title;
    app.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
      try { await api(path(b.dataset.restore) + '/restore', { method: 'POST' }); toast('Restored'); router(); } catch (e) { toast(e.message); }
    });
    app.querySelectorAll('[data-purge]').forEach(b => b.onclick = async () => {
      const v = b.dataset.purge;
      if (!confirm(`Delete “${title(v)}” permanently? Its activity and attached files are removed for good. This can’t be undone.`)) return;
      try { await api(path(v) + '/permanent', { method: 'DELETE' }); toast('Deleted permanently'); router(); } catch (e) { toast(e.message); }
    });
  }


  // ---------- account ----------
  async function viewAccount() {
    const prefs = await api('/me/email-prefs');
    const emailRows = [['email_assigned', 'A task is assigned to me'], ['email_approval', 'A task is waiting for my approval'],
      ['email_ready', 'My request is ready'], ...(prefs.can_unassigned ? [['email_unassigned', 'A request for my team is still unassigned after 24 hours']] : [])];
    app.innerHTML = `
      <div class="page-head"><div><h1>Your account</h1><p>${esc(me.name)} · ${esc(me.email)} · ${ROLE[me.role]}</p></div></div>
      <div class="account-grid">
        <form class="card" id="pwForm">
          <h2>Change password</h2>
          <label class="f"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
          <label class="f"><span>New password</span><input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
          <p class="err" id="pwErr"></p>
          <button class="btn">Change password</button>
        </form>
        <form class="card" id="prefsForm">
          <h2>Email notifications</h2>
          <p class="muted" style="font-size:.875rem;margin-top:-4px">Short emails to ${esc(me.email)} with a button to open the item. All are off until you turn them on.</p>
          ${prefs.email_enabled ? '' : '<p class="warn-text">Email isn’t set up on the server yet, so nothing will be sent.</p>'}
          ${emailRows.map(([k, l]) => `<label class="check-row"><input type="checkbox" name="${k}"${prefs[k] ? ' checked' : ''}> ${l}</label>`).join('')}
          <button class="btn" style="margin-top:8px">Save</button>
        </form>
        ${me.role === 'admin' ? '<section class="card" id="emailSettings"><h2>Email settings</h2><p class="muted">Loading…</p></section>' : ''}
      </div>`;
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try { await api('/me/password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } }); e.target.reset(); $('#pwErr').textContent = ''; toast('Password changed'); }
      catch (err) { $('#pwErr').textContent = err.message; }
    };
    $('#prefsForm').onsubmit = async e => {
      e.preventDefault();
      const body = Object.fromEntries(emailRows.map(([k]) => [k, e.target.elements[k].checked]));
      try { await api('/me/email-prefs', { method: 'PUT', body }); toast('Email notifications saved'); } catch (err) { toast(err.message); }
    };
    if (me.role === 'admin') renderEmailSettings(await api('/email/status'));
  }
  // Admins: what the server uses (never the password), the last error, and "Send test email" with the exact result.
  function renderEmailSettings(st, result) {
    const box = $('#emailSettings'); if (!box) return;
    const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
    box.innerHTML = `<h2>Email settings</h2>
      <p class="muted" style="font-size:.875rem;margin-top:-4px">Set in <code>server/.env</code> on the server (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL); restart the server after changing them.</p>
      ${st.configured ? '' : '<p class="warn-text">Email is off: SMTP_HOST, SMTP_USER or SMTP_PASS is missing.</p>'}
      <table class="kv">${row('Server', esc(`${st.host || '—'}:${st.port || '—'}`) + (st.ssl ? ' (SSL)' : ''))}${row('Sign-in', esc(st.user || '—'))}
        ${row('App password', st.password_set ? 'Set' : '<span class="warn-text">Missing</span>')}${row('Sender', esc(st.from))}${row('Links open', esc(st.app_url || '—'))}
        ${row('Sent since start', `${st.sent}${st.waiting ? ` · ${st.waiting} waiting` : ''}${st.failed ? ` · ${st.failed} failed` : ''}`)}
        ${row('Last error', st.last_error ? `<span class="err-inline">${esc(st.last_error.reason)}</span><br><span class="muted">${fmtDateTime(st.last_error.at)} · to ${esc(st.last_error.to)} · “${esc(st.last_error.subject)}”</span>` : '<span class="muted">None</span>')}</table>
      <div class="inline-actions" style="margin-top:12px"><button class="btn" id="testEmail"${st.configured ? '' : ' disabled'}>Send test email to ${esc(me.email)}</button></div>
      ${result ? `<p class="${result.ok ? 'ok-note' : 'err-note'}" role="status" id="testResult">${result.ok ? `Sent to ${esc(result.to)}. Check your inbox.` : `Not sent: ${esc(result.error)}`}</p>` : ''}`;
    $('#testEmail').onclick = async e => {
      e.target.disabled = true; e.target.textContent = 'Sending…';
      try { const r = await api('/email/test', { method: 'POST' }); renderEmailSettings(r.status, r); }
      catch (err) { renderEmailSettings(st, { ok: false, error: err.message }); }
    };
  }

  // ---------- chat ----------
  // #/chat and #/chat/:id. Live updates come from /api/stream (Server-Sent Events); while the stream is down the page
  // polls every 10 seconds. Messages are read when the conversation is open and the page is visible.
  const chat = { id: null, conv: null, members: [], messages: [], more: false, loading: false, pending: [], list: [] };
  let chatUnread = 0, stream = null, chatPollTimer = null;
  const MAX_CHAT_FILES = 5, MAX_CHAT_BYTES = 25 * 1048576;
  const chatPage = () => !!$('#chat');
  const parseTs = d => new Date(d.replace(' ', 'T') + (d.includes('Z') || d.includes('T') ? '' : 'Z'));
  const fmtTime = d => parseTs(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  function dayLabel(d) {
    const dt = parseTs(d), day = new Date(dt); day.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 864e5);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function listTime(d) {
    if (!d) return '';
    const l = dayLabel(d);
    return l === 'Today' ? fmtTime(d) : l === 'Yesterday' ? l : parseTs(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  // Text is escaped first; then web addresses become links. Line breaks are kept by CSS (pre-wrap).
  const linkify = s => esc(s).replace(/https?:\/\/(?:(?!&quot;|&lt;|&gt;|&#39;)[^\s])+/g, m => {
    const url = m.replace(/[.,;:!?)\]]+$/, ''), rest = m.slice(url.length);
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${rest}`;
  });
  function setChatUnread(n) {
    chatUnread = n || 0;
    const el = $('#chatCount');
    if (el) { el.textContent = chatUnread > 99 ? '99+' : chatUnread; el.hidden = !chatUnread; }
  }

  // ----- live updates -----
  function openStream() {
    if (stream) stream.close();
    stream = new EventSource('/api/stream');
    stream.addEventListener('message', e => onChatMessage(JSON.parse(e.data)));
    stream.addEventListener('deleted', e => onChatDeleted(JSON.parse(e.data)));
    stream.addEventListener('read', e => { const d = JSON.parse(e.data); setChatUnread(d.unread_total); if (chatPage()) refreshChatList(); });
    stream.addEventListener('conversation', e => {
      const d = JSON.parse(e.data) || {};
      if (!chatPage()) return refreshChatCount();
      refreshChatList();
      if (chat.id && (!d.conversation_id || d.conversation_id === chat.id)) reloadConversation();
    });
    stream.onopen = () => refreshChatCount(); // catch up on anything missed while it was down
  }
  function closeStream() { if (stream) stream.close(); stream = null; clearInterval(chatPollTimer); chatPollTimer = null; }
  // Fallback: every 10 s, if the stream isn't open, poll (and try to reopen a stream that gave up).
  function startChatPolling() {
    if (chatPollTimer) return;
    chatPollTimer = setInterval(async () => {
      if (!me) return;
      if (stream && stream.readyState === EventSource.OPEN) return;
      if (!stream || stream.readyState === EventSource.CLOSED) openStream();
      await refreshChatCount();
      if (chatPage() && chat.id) {
        const last = chat.messages.length ? chat.messages[chat.messages.length - 1].id : 0;
        try {
          const r = await api(`/chat/${chat.id}/messages?after=${last}`);
          let changed = false;
          for (const m of r.messages) if (!chat.messages.some(x => x.id === m.id)) { chat.messages.push(m); changed = true; }
          for (const id of r.deleted) { const m = chat.messages.find(x => x.id === id); if (m && !m.deleted) { Object.assign(m, { deleted: true, body: '', files: [] }); changed = true; } }
          if (changed) { renderMessages(); markRead(); }
        } catch (e) { /* next round */ }
      }
    }, 10000);
  }
  async function refreshChatCount() {
    try { const r = await api('/chat'); setChatUnread(r.unread_total); if (chatPage()) { chat.list = r.conversations; renderChatList(); } } catch (e) { /* offline */ }
  }
  const refreshChatList = refreshChatCount;
  function onChatMessage(d) {
    setChatUnread(d.unread_total);
    if (!chatPage()) return;
    if (d.conversation_id === chat.id && !chat.messages.some(m => m.id === d.message.id)) { chat.messages.push(d.message); renderMessages(); markRead(); }
    refreshChatList();
  }
  function onChatDeleted(d) {
    setChatUnread(d.unread_total);
    if (!chatPage()) return;
    const m = chat.id === d.conversation_id && chat.messages.find(x => x.id === d.message_id);
    if (m) { Object.assign(m, { deleted: true, body: '', files: [] }); renderMessages(); }
    refreshChatList();
  }
  // Read when the conversation is on screen and the page is visible and focused.
  async function markRead() {
    if (!chatPage() || !chat.id || !chat.messages.length || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const last = chat.messages[chat.messages.length - 1].id;
    if (last <= (chat.conv.last_read_message_id || 0)) return;
    chat.conv.last_read_message_id = last;
    try { const r = await api(`/chat/${chat.id}/read`, { method: 'POST', body: { message_id: last } }); setChatUnread(r.unread_total); } catch (e) { /* ignore */ }
  }
  document.addEventListener('visibilitychange', markRead);
  window.addEventListener('focus', markRead);

  // ----- page -----
  async function viewChat(id) {
    if (!chatPage()) {
      app.innerHTML = `<div class="chat" id="chat">
        <aside class="chat-side">
          <div class="chat-side-head"><h1>Chat</h1><div class="inline-actions"><button class="btn small" id="newChat">New chat</button><button class="btn ghost small" id="newGroup">New group</button></div></div>
          <input type="search" id="chatSearch" placeholder="Search messages and files" aria-label="Search your chats" autocomplete="off">
          <ul class="chat-list" id="chatList" aria-label="Conversations"></ul>
        </aside>
        <section class="chat-main" id="chatMain" aria-live="polite"></section>
      </div>`;
      $('#newChat').onclick = newChatForm;
      $('#newGroup').onclick = () => groupForm();
      let st;
      $('#chatSearch').oninput = e => { clearTimeout(st); st = setTimeout(() => chatSearch(e.target.value.trim()), 250); };
      await refreshChatList();
    }
    await openConversation(id || null);
  }
  function renderChatList() {
    const ul = $('#chatList'); if (!ul || $('#chatSearch').value.trim()) return;
    ul.innerHTML = chat.list.length ? chat.list.map(c => `<li><a href="#/chat/${c.id}"${c.id === chat.id ? ' aria-current="true"' : ''} class="${c.unread ? 'unread' : ''}">
        <span class="cl-top"><b>${esc(c.name)}</b><span class="cl-time">${esc(listTime(c.last_message_at))}</span></span>
        <span class="cl-bottom"><span class="cl-preview">${c.type === 'team' ? '<span class="cl-tag">Team</span>' : c.type === 'group' ? '<span class="cl-tag">Group</span>' : ''}${c.last ? `${c.type !== 'direct' || c.last.sender_name === 'You' ? esc(c.last.sender_name) + ': ' : ''}${c.last.deleted ? '<i>This message was deleted</i>' : esc(c.last.text)}` : '<span class="muted">No messages yet</span>'}</span>
          ${c.muted ? '<span title="Muted" aria-label="Muted">🔕</span>' : ''}${c.unread ? `<span class="pill accent cl-count" aria-label="${c.unread} unread">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</span></a></li>`).join('')
      : `<li class="empty">No chats yet. Start one with “New chat”.</li>`;
  }
  async function chatSearch(q) {
    const ul = $('#chatList');
    if (!q) return renderChatList();
    if (q.length < 2) { ul.innerHTML = `<li class="empty">Type at least 2 letters.</li>`; return; }
    const { results } = await api('/chat/search?q=' + encodeURIComponent(q));
    if ($('#chatSearch').value.trim() !== q) return;
    ul.innerHTML = results.length ? results.map(r => `<li><a href="#/chat/${r.conversation_id}">
        <span class="cl-top"><b>${esc(r.conversation_name)}</b><span class="cl-time">${esc(listTime(r.message.created_at))}</span></span>
        <span class="cl-preview">${esc(r.message.sender_name || 'Former member')}: ${esc(r.message.body.slice(0, 140)) || esc(r.message.files.map(f => '📎 ' + f.name).join(', '))}</span></a></li>`).join('')
      : `<li class="empty">Nothing found in your chats.</li>`;
  }
  async function reloadConversation() {
    try { await openConversation(chat.id, true); }
    catch (e) { chat.id = null; $('#chatMain').innerHTML = `<div class="empty">You’re no longer in this chat.</div>`; $('#chat').classList.remove('has-open'); }
  }
  async function openConversation(id, keepScroll) {
    const main = $('#chatMain');
    $('#chat').classList.toggle('has-open', !!id);
    if (!id) { chat.id = null; main.innerHTML = `<div class="empty chat-empty">Choose a chat on the left, or start a new one.</div>`; renderChatList(); return; }
    const d = await api('/chat/' + id).catch(e => { if (keepScroll) throw e; main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return null; });
    if (!d) { chat.id = null; return; }
    const same = chat.id === id, draft = same && $('#chatText') ? $('#chatText').value : '';
    Object.assign(chat, { id, conv: d.conversation, members: d.members });
    if (!same || !keepScroll) { chat.messages = d.messages; chat.more = d.more; chat.pending = []; }
    else for (const m of d.messages) { const i = chat.messages.findIndex(x => x.id === m.id); if (i < 0) chat.messages.push(m); else chat.messages[i] = m; }
    const c = d.conversation;
    const sub = c.type === 'direct' ? 'Direct chat' : `${c.type === 'team' ? 'Team chat' : 'Group'} · ${d.members.length} ${d.members.length === 1 ? 'person' : 'people'}`;
    main.innerHTML = `<header class="chat-head">
        <a href="#/chat" class="chat-back" aria-label="Back to chats">←</a>
        <div class="chat-title"><h2>${esc(c.name)}</h2><small class="muted">${esc(sub)}</small></div>
        <div class="inline-actions">
          <button class="btn ghost small" id="chatMute" aria-pressed="${c.muted}">${c.muted ? '🔕 Unmute' : 'Mute'}</button>
          ${c.type !== 'direct' ? `<button class="btn ghost small" id="chatPeople">People</button>` : ''}
          ${c.can_manage ? `<button class="btn ghost small" id="chatRename">Rename</button>` : ''}
          ${c.type === 'group' && !c.archived ? `<button class="btn danger small" id="chatLeave">Leave</button>` : ''}
        </div></header>
      <div class="chat-msgs" id="chatMsgs" tabindex="0" aria-label="Messages"></div>
      ${c.archived ? `<p class="chat-archived">This team was deleted. You can read this chat, but nobody can post in it.</p>` : `
      <form class="composer" id="composer">
        <div class="pending" id="pending"></div>
        <div class="composer-row">
          <label class="btn ghost clip" title="Attach files (or drop or paste them here)"><span aria-hidden="true">📎</span><span class="sr">Attach files</span><input type="file" id="chatFiles" multiple accept="${FILE_ACCEPT}" hidden></label>
          <textarea id="chatText" rows="1" maxlength="5000" placeholder="Write a message…" title="Enter sends, Shift+Enter starts a new line" aria-label="Message"></textarea>
          <button class="btn" type="submit" id="chatSend">Send</button>
        </div></form>`}
      <div class="drop-hint" id="dropHint" hidden>Drop files to attach them</div>`;
    renderMessages(!keepScroll || !same);
    renderChatList();
    $('#chatMute').onclick = async () => { await api(`/chat/${id}/mute`, { method: 'PUT', body: { muted: !c.muted } }); toast(c.muted ? 'Chat unmuted' : 'Chat muted – no notifications'); reloadConversation(); refreshChatList(); };
    if ($('#chatPeople')) $('#chatPeople').onclick = peopleDialog;
    if ($('#chatRename')) $('#chatRename').onclick = () => groupForm(c);
    if ($('#chatLeave')) $('#chatLeave').onclick = async () => {
      if (!confirm(`Leave “${c.name}”? You won’t see its messages any more.`)) return;
      try { await api(`/chat/${id}/leave`, { method: 'POST' }); toast('You left the group'); location.hash = '#/chat'; } catch (e) { toast(e.message); }
    };
    const msgs = $('#chatMsgs');
    msgs.onscroll = () => { if (msgs.scrollTop < 80) loadOlder(); };
    msgs.onclick = e => {
      const del = e.target.closest('[data-del]'), img = e.target.closest('[data-img]');
      if (del) deleteMessage(Number(del.dataset.del));
      if (img) lightbox(img.dataset.img, img.dataset.name, img.dataset.file);
    };
    if (!c.archived) { setupComposer(); if (draft) { $('#chatText').value = draft; $('#chatText').oninput(); } }
    markRead();
  }
  function renderMessages(toBottom) {
    const box = $('#chatMsgs'); if (!box) return;
    const nearBottom = toBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    let html = chat.more ? `<p class="chat-more muted">Scroll up for older messages</p>` : chat.messages.length ? '' : `<p class="empty">No messages yet. Say hello!</p>`;
    let prev = null;
    for (const m of chat.messages) {
      const day = dayLabel(m.created_at);
      if (!prev || dayLabel(prev.created_at) !== day) { html += `<div class="day-sep"><span>${esc(day)}</span></div>`; prev = null; }
      const grouped = prev && prev.sender_id === m.sender_id && parseTs(m.created_at) - parseTs(prev.created_at) < 5 * 60e3;
      const mine = m.sender_id === me.id;
      html += `<div class="msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}" data-id="${m.id}">
        ${grouped ? '' : `<div class="msg-head"><b>${mine ? 'You' : esc(m.sender_name || 'Former member')}</b> <time datetime="${esc(m.created_at)}">${esc(fmtTime(m.created_at))}</time></div>`}
        <div class="msg-line">${mine && !m.deleted ? `<button type="button" class="msg-del" data-del="${m.id}" title="Delete this message" aria-label="Delete this message">🗑</button>` : ''}${m.deleted ? `<div class="bubble deleted"><i>This message was deleted</i></div>` : `<div class="bubble" title="${esc(fmtTime(m.created_at))}">${m.body ? `<div class="msg-text">${linkify(m.body)}</div>` : ''}${m.files.map(fileHtml).join('')}</div>`}</div>
      </div>`;
      prev = m;
    }
    box.innerHTML = html;
    if (nearBottom) box.scrollTop = box.scrollHeight;
    // Images change the height once they load.
    if (nearBottom) box.querySelectorAll('img').forEach(i => { if (!i.complete) i.onload = () => { box.scrollTop = box.scrollHeight; }; });
  }
  function fileHtml(f) {
    if (f.is_image) return `<button type="button" class="thumb" data-img="/api/files/${f.id}?inline=1" data-file="${f.id}" data-name="${esc(f.name)}" aria-label="Open image ${esc(f.name)}"><img src="/api/files/${f.id}?inline=1" alt="${esc(f.name)}" loading="lazy"></button>`;
    const ext = (f.name.split('.').pop() || '').slice(0, 4).toUpperCase();
    return `<div class="file-card"><span class="file-ext">${esc(ext)}</span><span class="file-info"><b>${esc(f.name)}</b><small class="muted">${fmtSize(f.size)}</small></span>
      <a class="btn ghost small" href="/api/files/${f.id}" download>Download</a></div>`;
  }
  async function loadOlder() {
    if (!chat.more || chat.loading || !chat.messages.length) return;
    chat.loading = true;
    const box = $('#chatMsgs'), id = chat.id, fromBottom = box.scrollHeight - box.scrollTop;
    try {
      const r = await api(`/chat/${id}/messages?before=${chat.messages[0].id}`);
      if (chat.id !== id) return;
      chat.messages = r.messages.concat(chat.messages); chat.more = r.more;
      renderMessages(); box.scrollTop = box.scrollHeight - fromBottom; // stay where you were
    } finally { chat.loading = false; }
  }
  async function deleteMessage(mid) {
    if (!confirm('Delete this message for everyone? Its files will no longer be available.')) return;
    try { await api('/chat/messages/' + mid, { method: 'DELETE' }); const m = chat.messages.find(x => x.id === mid); if (m) Object.assign(m, { deleted: true, body: '', files: [] }); renderMessages(); }
    catch (e) { toast(e.message); }
  }
  function lightbox(src, name, fileId) {
    const lb = $('#lightbox');
    lb.querySelector('img').src = src; lb.querySelector('img').alt = name;
    lb.querySelector('.lb-name').textContent = name;
    lb.querySelector('a').href = '/api/files/' + fileId;
    lb.showModal();
  }
  $('#lightbox').onclick = e => { if (!e.target.closest('a')) $('#lightbox').close(); };

  // ----- composer: text, paperclip, drag and drop, pasted images -----
  function setupComposer() {
    const form = $('#composer'), text = $('#chatText'), main = $('#chatMain');
    const grow = () => { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 160) + 'px'; };
    text.oninput = grow;
    text.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
    $('#chatFiles').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
    text.onpaste = e => {
      const files = [...(e.clipboardData && e.clipboardData.files) || []];
      if (!files.length) return; // plain text pastes normally
      e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      addFiles(files.map((f, i) => f.type.startsWith('image/') && (!f.name || f.name === 'image.png')
        ? new File([f], `pasted-image-${stamp}${i ? '-' + i : ''}.${({ 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[f.type] || 'png'}`, { type: f.type }) : f));
    };
    let depth = 0;
    const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    main.ondragenter = e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('#dropHint').hidden = false; };
    main.ondragover = e => { if (hasFiles(e)) e.preventDefault(); };
    main.ondragleave = () => { if (--depth <= 0) { depth = 0; $('#dropHint').hidden = true; } };
    main.ondrop = e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; $('#dropHint').hidden = true; addFiles([...e.dataTransfer.files]); };
    form.onsubmit = async e => {
      e.preventDefault();
      const body = text.value.trim();
      if (!body && !chat.pending.length) return;
      const btn = $('#chatSend'); btn.disabled = true;
      try {
        const r = await api(`/chat/${chat.id}/messages`, { method: 'POST', body: formData({ body }, { files: chat.pending }) });
        text.value = ''; grow(); chat.pending = []; renderPending();
        if (!chat.messages.some(m => m.id === r.message.id)) chat.messages.push(r.message);
        chat.conv.last_read_message_id = r.message.id;
        renderMessages(true); refreshChatList();
      } catch (err) { toast(err.message); }
      finally { btn.disabled = false; text.focus(); }
    };
    renderPending();
    text.focus();
  }
  function addFiles(files) {
    const ok = FILE_ACCEPT.split(',');
    for (const f of files) {
      if (chat.pending.length >= MAX_CHAT_FILES) { toast(`You can attach up to ${MAX_CHAT_FILES} files to one message.`); break; }
      if (!ok.includes('.' + (f.name.split('.').pop() || '').toLowerCase())) { toast(`“${f.name}” isn’t an allowed file type.`); continue; }
      if (f.size > MAX_CHAT_BYTES) { toast(`“${f.name}” is bigger than 25 MB.`); continue; }
      chat.pending.push(f);
    }
    renderPending();
  }
  function renderPending() {
    const el = $('#pending'); if (!el) return;
    el.innerHTML = chat.pending.map((f, i) => `<span class="chip">📎 ${esc(f.name)} <small>${fmtSize(f.size)}</small><button type="button" data-rmf="${i}" aria-label="Remove ${esc(f.name)}">✕</button></span>`).join('');
    el.querySelectorAll('[data-rmf]').forEach(b => b.onclick = () => { chat.pending.splice(Number(b.dataset.rmf), 1); renderPending(); });
  }

  // ----- new chat / group / people -----
  async function newChatForm() {
    const { people } = await api('/chat/people');
    openModal(`<h2 style="font-size:1.25rem">New chat</h2>${pickerHtml('Person', 'Type a name to find someone.')}${modalActions('Open chat')}`, async () => {
      const id = picker.values()[0]; if (!id) throw new Error('Choose a person.');
      const r = await api('/chat/direct', { method: 'POST', body: { user_id: id } });
      location.hash = '#/chat/' + r.conversation_id;
    });
    const picker = personPicker(modalForm.querySelector('.picker'), people, { multiple: false });
  }
  async function groupForm(c) {
    if (c) {
      openModal(`<h2 style="font-size:1.25rem">Rename group</h2><label class="f"><span>Group name</span><input name="name" required maxlength="100" value="${esc(c.name)}"></label>${modalActions('Save')}`, async fd => {
        await api('/chat/' + c.id, { method: 'PATCH', body: { name: fd.get('name') } }); toast('Group renamed'); reloadConversation(); refreshChatList();
      });
      return;
    }
    const { people } = await api('/chat/people');
    openModal(`<h2 style="font-size:1.25rem">New group</h2><label class="f"><span>Group name</span><input name="name" required maxlength="100"></label>
      ${pickerHtml('People', 'Type names to add people. You are added automatically.')}${modalActions('Create group')}`, async fd => {
      const r = await api('/chat/groups', { method: 'POST', body: { name: fd.get('name'), user_ids: picker.values() } });
      toast('Group created'); location.hash = '#/chat/' + r.conversation_id;
    });
    const picker = personPicker(modalForm.querySelector('.picker'), people);
  }
  async function peopleDialog() {
    const c = chat.conv, manage = c.can_manage;
    const people = manage ? (await api('/chat/people')).people.filter(p => !chat.members.some(m => m.id === p.id)) : [];
    openModal(`<h2 style="font-size:1.25rem">People in ${esc(c.name)}</h2>
      ${c.type === 'team' ? '<p class="muted">Team chats follow team membership (and include the team’s leads).</p>' : ''}
      <ul class="rows chat-people">${chat.members.map(m => `<li><span><b>${esc(m.name)}</b>${m.id === me.id ? ' (you)' : ''}${m.id === c.created_by && c.type === 'group' ? ' <span class="pill accent">Made the group</span>' : ''}${m.active ? '' : ' <span class="muted">(deactivated)</span>'}
        <small class="muted">${esc(m.team_name || '')}</small></span>
        ${manage && m.id !== me.id ? `<button type="button" class="btn danger small" data-rmm="${m.id}">Remove</button>` : ''}</li>`).join('')}</ul>
      ${manage ? pickerHtml('Add people', 'Type a name, then press “Add”.') : ''}
      <div class="modal-actions"><button class="btn ghost" value="cancel" formnovalidate>Close</button>${manage ? '<button class="btn" type="submit">Add</button>' : ''}</div>`, async () => {
      const ids = picker ? picker.values() : [];
      if (!ids.length) throw new Error('Choose someone to add.');
      for (const id of ids) await api(`/chat/${c.id}/members/${id}`, { method: 'PUT' });
      toast(ids.length === 1 ? 'Person added' : 'People added'); reloadConversation();
    });
    const picker = manage ? personPicker(modalForm.querySelector('.picker'), people) : null;
    modalForm.querySelectorAll('[data-rmm]').forEach(b => b.onclick = async () => {
      const m = chat.members.find(x => x.id === Number(b.dataset.rmm));
      if (!confirm(`Remove ${m.name} from “${c.name}”?`)) return;
      try { await api(`/chat/${c.id}/members/${m.id}`, { method: 'DELETE' }); modal.close(); toast(m.name + ' removed'); reloadConversation(); } catch (e) { toast(e.message); }
    });
  }

  router();
})();

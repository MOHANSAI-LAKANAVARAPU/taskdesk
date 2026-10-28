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
    if (isBoss()) items.push(['#/people', 'People']);
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
    if (!me && route !== 'login') {
      try { me = (await api('/me')).user; } catch (e) { location.hash = '#/login'; return; }
    }
    if (route === 'login') { $('#topbar').hidden = true; return viewLogin(); }
    // The old "My team" page (and People for non-managers) is now the Teams page.
    if (route === 'my-team' || (route.startsWith('people') && !isBoss())) return location.replace('#/teams');
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
      else if (parts[0] === 'people') await viewPeople();
      else if (parts[0] === 'requests' && parts[1]) await viewRequest(Number(parts[1]));
      else if (parts[0] === 'requests') await viewRequests();
      else if (parts[0] === 'teams' && parts[1]) await viewTeam(Number(parts[1]));
      else if (parts[0] === 'teams') await viewTeams();
      else if (parts[0] === 'history') await viewHistory();
      else if (parts[0] === 'chat') await viewChat(Number(parts[1]) || null);
      else if (parts[0] === 'account') viewAccount();
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
      <p class="muted" style="font-size:.875rem;margin-top:14px">Forgot your password? Ask your manager or admin to reset it.</p>
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
  async function viewTasks() {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const params = new URLSearchParams();
    for (const k of ['status', 'project', 'assignee', 'mine']) if (q.get(k)) params.set(k, q.get(k));
    const [{ tasks }, { projects }, { users }] = await Promise.all([api('/tasks?' + params), api('/projects'), api('/users')]);
    const setQ = (k, v) => { if (v) q.set(k, v); else q.delete(k); location.hash = '#/tasks' + (q.toString() ? '?' + q : ''); };

    const list = tasks.length ? `<ul class="task-list">${tasks.map(t => `<li><a href="#/tasks/${t.id}">
        <span class="t-title">${esc(t.title)}</span>
        <span class="t-meta"><span>${esc(dueText(t))}</span>${me.role !== 'employee' ? `<span>${esc(t.assignee_name)}</span>` : `<span>From ${esc(t.assigned_by_name)}</span>`}${t.project_name ? `<span>${esc(t.project_name)}</span>` : ''}<span class="pr-${t.priority}">${PRIORITY[t.priority]} priority</span></span>
        <span class="t-side">${statusPill(t)}<span class="mini" aria-label="${t.progress}% done"><i style="width:${t.progress}%"></i></span></span>
      </a></li>`).join('')}</ul>`
      : `<div class="card empty">${q.toString() ? 'No tasks match these filters.' : canAssign() ? 'No tasks yet. Assign the first one to get started.' : 'No tasks have been assigned to you yet.'}</div>`;

    app.innerHTML = `
      <div class="page-head"><div><h1>${me.role === 'employee' ? 'My tasks' : 'Tasks'}</h1><p>${tasks.length} task${tasks.length === 1 ? '' : 's'}</p></div>
        ${canAssign() ? `<button class="btn" id="newTask">Assign a task</button>` : ''}</div>
      <div class="filters">
        <select id="fStatus" aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="open"${q.get('status') === 'open' ? ' selected' : ''}>All open</option>
          ${options(STATUS, q.get('status'))}
          <option value="overdue"${q.get('status') === 'overdue' ? ' selected' : ''}>Overdue</option>
        </select>
        <select id="fProject" aria-label="Filter by project"><option value="">All projects</option>
          ${projects.map(p => `<option value="${p.id}"${String(p.id) === q.get('project') ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        ${me.role !== 'employee' ? `<select id="fAssignee" aria-label="Filter by person"><option value="">Everyone</option>
          ${users.map(u => `<option value="${u.id}"${String(u.id) === q.get('assignee') ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
          <select id="fMine" aria-label="Filter by who assigned"><option value="">Assigned by anyone</option><option value="assigned_by_me"${q.get('mine') ? ' selected' : ''}>Assigned by me</option></select>` : ''}
      </div>
      ${list}`;
    $('#fStatus').onchange = e => setQ('status', e.target.value);
    $('#fProject').onchange = e => setQ('project', e.target.value);
    if ($('#fAssignee')) { $('#fAssignee').onchange = e => setQ('assignee', e.target.value); $('#fMine').onchange = e => setQ('mine', e.target.value); }
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
  async function viewProjects() {
    const { projects } = await api('/projects');
    app.innerHTML = `
      <div class="page-head"><div><h1>Projects</h1><p>Progress counts completed tasks against all tasks in each project.</p></div>
        ${isBoss() ? `<button class="btn" id="newProj">New project</button>` : ''}</div>
      ${projects.length ? `<div class="card table-wrap"><table>
        <thead><tr><th>Project</th><th>Status</th><th class="n">Assigned</th><th class="n">Completed</th><th style="min-width:140px">Progress</th>${isBoss() ? '<th></th>' : ''}</tr></thead>
        <tbody>${projects.map(p => `<tr>
          <td><a href="#/tasks?project=${p.id}">${esc(p.name)}</a>${p.description ? `<div class="muted" style="font-size:.8125rem">${esc(p.description)}</div>` : ''}</td>
          <td>${PSTATUS[p.status]}</td><td class="n">${p.total}</td><td class="n">${p.completed}</td>
          <td>${bar(p.total, p.completed)}<div class="num" style="margin-top:4px">${p.total ? Math.round(p.completed / p.total * 100) : 0}%</div></td>
          ${isBoss() ? `<td><button class="btn ghost small" data-edit="${p.id}">Edit</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty">${isBoss() ? 'No projects yet. Create one to group related tasks.' : 'No projects yet.'}</div>`}`;
    const form = p => openModal(`
      <h2 style="font-size:1.25rem">${p ? 'Edit project' : 'New project'}</h2>
      <label class="f"><span>Name</span><input name="name" required maxlength="160" value="${esc(p?.name)}"></label>
      <label class="f"><span>Description</span><textarea name="description">${esc(p?.description)}</textarea></label>
      ${p ? `<label class="f"><span>Status</span><select name="status">${options(PSTATUS, p.status)}</select></label>` : ''}
      ${modalActions(p ? 'Save changes' : 'Create project')}`,
      async fd => {
        const body = Object.fromEntries(fd);
        if (!body.name.trim()) throw new Error('Enter a project name.');
        await api(p ? '/projects/' + p.id : '/projects', { method: p ? 'PATCH' : 'POST', body });
        toast(p ? 'Project updated' : 'Project created'); router();
      });
    const nb = $('#newProj'); if (nb) nb.onclick = () => form();
    app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(projects.find(p => p.id === +b.dataset.edit)));
  }

  // ---------- people ----------
  async function viewPeople() {
    const [{ users }, { teams }] = await Promise.all([api('/users'), api('/teams')]);
    const byId = Object.fromEntries(users.map(u => [u.id, u]));
    // "Lead of <team>" next to the role; a team lead who leads no team gets a warning.
    const roleCell = u => {
      const led = teams.filter(t => t.leads.some(l => l.id === u.id));
      if (led.length) return `${ROLE[u.role]}<div class="muted" style="font-size:.8125rem">Lead of ${led.map(t => `<a href="#/teams/${t.id}">${esc(t.name)}</a>`).join(', ')}</div>`;
      if (u.role === 'lead' && u.active) return `${ROLE[u.role]}<div class="warn-text" style="margin:2px 0 0;font-size:.8125rem">⚠ Not leading a team yet – set it on the <a href="#/teams">Teams page</a></div>`;
      return ROLE[u.role];
    };
    app.innerHTML = `
      <div class="page-head"><div><h1>People</h1><p>Add people and choose their team. A team lead added to a team becomes one of its leads.</p></div>
        <button class="btn" id="newUser">Add a person</button></div>
      <div class="card table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map(u => `<tr>
          <td><a href="#/tasks?assignee=${u.id}">${esc(u.name)}</a></td><td>${esc(u.email)}</td><td>${roleCell(u)}</td>
          <td>${u.team_name ? esc(u.team_name) : '<span class="muted">—</span>'}</td>
          <td>${u.active ? 'Active' : '<span class="muted">Deactivated</span>'}</td>
          <td>${u.role === 'admin' && me.role !== 'admin' ? '' : `<button class="btn ghost small" data-edit="${u.id}">Edit</button>`}</td></tr>`).join('')}</tbody></table></div>`;
    const roles = me.role === 'admin' ? ROLE : { manager: 'Manager', lead: 'Team lead', employee: 'Employee' };
    const form = u => openModal(`
      <h2 style="font-size:1.25rem">${u ? 'Edit ' + esc(u.name) : 'Add a person'}</h2>
      <div class="grid2">
        <label class="f"><span>Full name</span><input name="name" required value="${esc(u?.name)}"></label>
        <label class="f"><span>Email</span><input name="email" type="email" required value="${esc(u?.email)}"></label>
        <label class="f"><span>Role</span><select name="role">${options(roles, u?.role || 'employee')}</select></label>
        <label class="f"><span>Team</span><select name="team_id"><option value="">No team</option>
          ${teams.map(t => `<option value="${t.id}"${u && t.id === u.team_id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      </div>
      <label class="f"><span>${u ? 'New password (leave empty to keep current)' : 'Temporary password'}</span><input name="password" type="text" minlength="8" autocomplete="new-password" ${u ? '' : 'required'}></label>
      ${u && u.id !== me.id ? `<label class="f" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" style="width:auto" ${u.active ? 'checked' : ''}> Account active</label>` : ''}
      <p class="muted" style="font-size:.8125rem;margin-top:-4px">A team’s leads can assign tasks to the people in that team.</p>
      ${modalActions(u ? 'Save changes' : 'Add person')}`,
      async fd => {
        const body = Object.fromEntries(fd);
        if (u && u.id !== me.id) body.active = fd.get('active') === 'on';
        if (u && !body.password) delete body.password;
        const r = await api(u ? '/users/' + u.id : '/users', { method: u ? 'PATCH' : 'POST', body });
        const lead = r.became_lead ? `${r.became_lead.name} is now a lead of ${r.became_lead.team_name}.` : '';
        toast(u ? lead || 'Changes saved' : `${body.name} added. ${lead} Share their email and temporary password with them.`); router();
      });
    $('#newUser').onclick = () => form();
    app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(byId[b.dataset.edit]));
  }

  // ---------- teams (everyone: company directory; managers and admins manage them) ----------
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  async function viewTeams() {
    const { teams } = await api('/teams');
    teams.sort((a, b) => b.mine - a.mine); // your own team first (the server sorts by name)
    app.innerHTML = `
      <div class="page-head"><div><h1>Teams</h1><p>Every team and who is in it. A team’s leads assign its work and its incoming document requests.</p></div>
        ${isBoss() ? `<button class="btn" id="newTeam">Add a team</button>` : ''}</div>
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
  async function viewRequests() {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const params = new URLSearchParams();
    for (const k of ['team', 'status']) if (q.get(k)) params.set(k, q.get(k));
    const [{ requests }, { teams }] = await Promise.all([api('/requests?' + params), api('/teams')]);
    const setQ = (k, v) => { if (v) q.set(k, v); else q.delete(k); location.hash = '#/requests' + (q.toString() ? '?' + q : ''); };
    app.innerHTML = `
      <div class="page-head"><div><h1>Document requests</h1><p>Ask another team for a document. A member of that team takes it on, and you’re told when it’s ready.</p></div>
        <button class="btn" id="newReq">New request</button></div>
      <div class="filters">
        <select id="fTeam" aria-label="Filter by team"><option value="">All teams</option>
          ${teams.map(t => `<option value="${t.id}"${String(t.id) === q.get('team') ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <select id="fStatus" aria-label="Filter by status"><option value="">All statuses</option>
          <option value="active"${q.get('status') === 'active' ? ' selected' : ''}>Not finished</option>${options(RSTATUS, q.get('status'))}</select>
      </div>
      ${requests.length ? `<div class="card table-wrap"><table>
        <thead><tr><th>Title</th><th>Requested by</th><th>For team</th><th>Needed by</th><th>Status</th><th>Taken by</th></tr></thead>
        <tbody>${requests.map(r => `<tr><td><a href="#/requests/${r.id}">${esc(r.title)}</a></td><td>${esc(r.requested_by_name)}</td>
          <td>${r.team_name ? esc(r.team_name) : r.status === 'needs_team' ? '<span class="muted">Not decided yet</span>' : '<span class="muted">—</span>'}</td><td>${fmtDate(r.needed_by)}</td><td>${reqPill(r)}</td>
          <td>${r.assignee_name ? esc(r.assignee_name) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty">${q.toString() ? 'No requests match these filters.' : 'No document requests yet.'}</div>`}`;
    $('#fTeam').onchange = e => setQ('team', e.target.value);
    $('#fStatus').onchange = e => setQ('status', e.target.value);
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
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const params = new URLSearchParams();
    for (const k of ['person', 'team', 'status', 'from', 'to']) if (q.get(k)) params.set(k, q.get(k));
    const [{ rows }, { users }, { teams }] = await Promise.all([api('/history?' + params), api('/users'), api('/teams')]);
    const setQ = (k, v) => { if (v) q.set(k, v); else q.delete(k); location.hash = '#/history' + (q.toString() ? '?' + q : ''); };
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
      <div class="filters">
        ${users.length > 1 ? `<select id="hPerson" aria-label="Filter by person"><option value="">Everyone</option>
          ${users.map(u => `<option value="${u.id}"${String(u.id) === q.get('person') ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
        <select id="hTeam" aria-label="Filter by team"><option value="">All teams</option>
          ${teams.map(t => `<option value="${t.id}"${String(t.id) === q.get('team') ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
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
    $('#hTeam').onchange = e => setQ('team', e.target.value);
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
  function viewAccount() {
    app.innerHTML = `
      <div class="page-head"><div><h1>Your account</h1><p>${esc(me.name)} · ${esc(me.email)} · ${ROLE[me.role]}</p></div></div>
      <form class="card" id="pwForm" style="max-width:420px">
        <h2>Change password</h2>
        <label class="f"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
        <label class="f"><span>New password</span><input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
        <p class="err" id="pwErr"></p>
        <button class="btn">Change password</button>
      </form>`;
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try { await api('/me/password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } }); e.target.reset(); $('#pwErr').textContent = ''; toast('Password changed'); }
      catch (err) { $('#pwErr').textContent = err.message; }
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

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
    items.push(['#/teams', 'Teams'], ['#/history', 'History']);
    $('#nav').innerHTML = items.map(([h, l]) => {
      const cur = h === '#/' ? route === '' : route.startsWith(h.slice(2));
      return `<a href="${h}"${cur ? ' aria-current="page"' : ''}>${l}</a>`;
    }).join('');
    $('#meName').textContent = me.name;
    $('#topbar').hidden = false;
  }
  $('#logoutBtn').onclick = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); me = null; location.hash = '#/login'; };

  async function router() {
    const route = location.hash.replace(/^#\/?/, '');
    if (!me && route !== 'login') {
      try { me = (await api('/me')).user; } catch (e) { location.hash = '#/login'; return; }
    }
    if (route === 'login') { $('#topbar').hidden = true; return viewLogin(); }
    // The old "My team" page (and People for non-managers) is now the Teams page.
    if (route === 'my-team' || (route.startsWith('people') && !isBoss())) return location.replace('#/teams');
    renderNav(route);
    app.innerHTML = `<p class="muted">Loading…</p>`;
    const parts = route.split('?')[0].split('/');
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
      else if (parts[0] === 'account') viewAccount();
      else app.innerHTML = `<div class="empty">This page doesn’t exist. <a href="#/">Go to the dashboard</a>.</div>`;
    } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    app.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', router);

  // ---------- login ----------
  function viewLogin() {
    app.innerHTML = `<div class="login">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>TaskDesk</div>
      <form class="card" id="loginForm">
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
      if (!confirm('Give this request back? The task and any files attached to it will be removed, and the request goes back to the team as open.')) return;
      try { const r = await api(`/tasks/${t.id}/give-back`, { method: 'POST' }); toast('Request given back to the team'); location.hash = '#/requests/' + r.request_id; }
      catch (e) { toast(e.message); }
    };
    if (can_edit) {
      $('#editTask').onclick = () => taskForm(t);
      $('#delTask').onclick = async () => {
        if (!confirm('Delete this task and its updates? This can’t be undone.')) return;
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
      const led = teams.filter(t => t.lead_id === u.id);
      if (led.length) return `${ROLE[u.role]}<div class="muted" style="font-size:.8125rem">Lead of ${led.map(t => `<a href="#/teams/${t.id}">${esc(t.name)}</a>`).join(', ')}</div>`;
      if (u.role === 'lead' && u.active) return `${ROLE[u.role]}<div class="warn-text" style="margin:2px 0 0;font-size:.8125rem">⚠ Not leading a team yet – set it on the <a href="#/teams">Teams page</a></div>`;
      return ROLE[u.role];
    };
    app.innerHTML = `
      <div class="page-head"><div><h1>People</h1><p>Add people and choose their team. A team lead added to a team without a lead becomes its lead.</p></div>
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
      <p class="muted" style="font-size:.8125rem;margin-top:-4px">A team’s lead can assign tasks to the people in that team.</p>
      ${modalActions(u ? 'Save changes' : 'Add person')}`,
      async fd => {
        const body = Object.fromEntries(fd);
        if (u && u.id !== me.id) body.active = fd.get('active') === 'on';
        if (u && !body.password) delete body.password;
        const r = await api(u ? '/users/' + u.id : '/users', { method: u ? 'PATCH' : 'POST', body });
        const lead = r.became_lead ? `${r.became_lead.name} is now the lead of ${r.became_lead.team_name}.` : '';
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
      <div class="page-head"><div><h1>Teams</h1><p>Every team and who is in it. A team’s lead assigns its work and its incoming document requests.</p></div>
        ${isBoss() ? `<button class="btn" id="newTeam">Add a team</button>` : ''}</div>
      ${teams.length ? `<div class="team-grid">${teams.map(t => `<a class="card team-card${t.mine ? ' mine' : ''}" href="#/teams/${t.id}">
        <div class="row-top"><h2>${esc(t.name)}</h2>${t.mine ? '<span class="pill accent">Your team</span>' : ''}</div>
        <p class="${t.lead_name ? '' : isBoss() ? 'warn-text' : 'muted'}">${t.lead_name ? 'Lead: ' + esc(t.lead_name) : isBoss() ? '⚠ No lead' : 'No lead yet'}</p>
        <p class="muted">${plural(t.member_count, 'active member')}</p>
        ${t.can_see_counts ? `<p class="team-counts"><span><b>${t.open_tasks}</b> open task${t.open_tasks === 1 ? '' : 's'}</span><span><b>${t.open_requests}</b> open request${t.open_requests === 1 ? '' : 's'}</span></p>` : ''}
      </a>`).join('')}</div>` : '<div class="card empty">No teams yet.</div>'}`;
    if (isBoss()) $('#newTeam').onclick = () => teamNameForm();
  }
  // Add a team / rename a team (managers and admins).
  function teamNameForm(t) {
    openModal(`<h2 style="font-size:1.25rem">${t ? 'Rename ' + esc(t.name) : 'Add a team'}</h2>
      <label class="f"><span>Team name</span><input name="name" required maxlength="120" value="${esc(t?.name)}"></label>
      ${t ? '' : '<p class="muted" style="font-size:.8125rem;margin-top:-4px">Then open the team to add members and set its lead.</p>'}
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
        ${d.can_manage ? `<div class="inline-actions"><button class="btn" id="addMember">Add member</button><button class="btn ghost" id="setLead">Set lead</button>
          <button class="btn ghost" id="renameTeam">Rename</button><button class="btn danger" id="delTeam">Delete</button></div>` : ''}</div>
      <section class="card" style="margin-bottom:20px"><h2>Lead</h2>
        ${d.lead ? `<p style="margin:0"><b>${esc(d.lead.name)}</b> <span class="muted">${ROLE[d.lead.role]} · ${esc(d.lead.email)}${d.lead.team_id === t.id ? '' : ' · not a member of this team'}</span></p>`
          : `<p class="${d.can_manage ? 'warn-text' : 'muted'}" style="margin:0">${d.can_manage ? '⚠ This team has no lead. Its document requests can only be assigned and approved by a manager. Use “Set lead”.' : 'This team has no lead yet.'}</p>`}
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
    const leadToast = r => toast(r && r.became_lead ? `${r.became_lead.name} is now the lead of ${r.became_lead.team_name}` : 'Added to the team');
    app.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
      const m = d.members.find(x => x.id === Number(b.dataset.remove));
      if (!confirm(`Remove ${m.name} from ${t.name}?${m.is_lead ? ' They stay the team’s lead until you set another lead.' : ''}`)) return;
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
        ${pickerHtml('Person', 'Someone already in another team moves to this one. A team lead added to a team without a lead becomes its lead.')}
        ${modalActions('Add member')}`, async () => {
        const [uid] = picker.values();
        if (!uid) throw new Error('Choose a person.');
        leadToast(await api(`/teams/${t.id}/members/${uid}`, { method: 'PUT' })); router();
      });
      const picker = personPicker(modalForm.querySelector('.picker'), people, { multiple: false });
    };
    // Lead choices: active team leads, managers and admins; say if they already lead another team.
    $('#setLead').onclick = () => {
      const leads = users.filter(u => u.active && u.role !== 'employee');
      const leading = id => teams.filter(x => x.lead_id === id && x.id !== t.id).map(x => x.name);
      openModal(`<h2 style="font-size:1.25rem">Set the lead of ${esc(t.name)}</h2>
        <label class="f"><span>Team lead</span><select name="lead_id"><option value="">No lead</option>
          ${leads.map(l => { const o = leading(l.id); return `<option value="${l.id}"${l.id === t.lead_id ? ' selected' : ''}>${esc(l.name)} (${ROLE[l.role]}${l.team_name ? ', ' + esc(l.team_name) : ''})${o.length ? ' – already leads ' + esc(o.join(', ')) : ''}</option>`; }).join('')}</select></label>
        <p class="muted" style="font-size:.8125rem;margin-top:-4px">Only active team leads, managers and admins can lead a team. Change someone’s role on the People page.</p>
        ${modalActions('Save')}`, async fd => {
        await api('/teams/' + t.id, { method: 'PATCH', body: { lead_id: fd.get('lead_id') || null } });
        toast('Team lead saved'); router();
      });
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
    $('#newReq').onclick = () => openModal(`
      <h2 style="font-size:1.25rem">New document request</h2>
      <label class="f"><span>What do you need?</span><input name="title" required maxlength="200"></label>
      <label class="f"><span>Details</span><textarea name="description" placeholder="What the document should contain, format, who it is for"></textarea></label>
      <div class="grid2">
        <label class="f"><span>Which team?</span><select name="target_team_id" required><option value="">Choose a team</option>
          ${teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}<option value="none">Not sure, let a manager decide</option></select></label>
        <label class="f"><span>Needed by</span><input type="date" name="needed_by"></label>
      </div>
      ${fileInput()}
      ${modalActions('Post request')}`, async fd => {
        const body = Object.fromEntries([...fd].filter(([k]) => k !== 'files'));
        if (!body.title.trim()) throw new Error('Enter what you need.');
        if (!body.target_team_id) throw new Error('Choose a team, or “Not sure, let a manager decide”.');
        const r = await api('/requests', { method: 'POST', body: formData(body, modalForm.querySelector('[name=files]')) });
        toast('Request posted'); location.hash = '#/requests/' + r.request.id;
      });
  }

  // "Assign to" for an open request (request page and the dashboard's "Requests to assign"): one person, type to search.
  // The team's lead sees its active members; managers/admins see everyone, the request's team first (server order).
  // The current user isn't listed: they use "Take this task".
  const assignable = d => d.members.filter(m => m.id !== me.id)
    .map(m => ({ ...m, team_name: m.team_id === d.request.target_team_id ? `${m.team_name} (this request’s team)` : m.team_name || 'No team' }));
  function assignPickerHtml(d) {
    if (!assignable(d).length) return `<p class="muted" style="margin:0">No other members in ${esc(d.request.team_name)} yet – add them on the <a href="#/teams/${d.request.target_team_id}">Teams page</a>.</p>`;
    return `${pickerHtml('Person', isBoss() ? 'Anyone can be chosen; people in the request’s team are listed first.' : `Active members of ${esc(d.request.team_name)}.`)}
      <p class="err" id="assignErr"></p><button class="btn">Assign</button>`;
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
      ${assignable(d).length ? pickerHtml('Assign to', isBoss() ? 'People in the request’s team are listed first.' : `Active members of ${esc(d.request.team_name)}.`) + modalActions('Assign')
        : assignPickerHtml(d) + '<div class="modal-actions"><button class="btn ghost" value="cancel" formnovalidate>Close</button></div>'}`, async () => {
      const [uid] = picker ? picker.values() : [];
      if (!uid) throw new Error('Choose a person.');
      await api(`/requests/${id}/assign`, { method: 'POST', body: { user_id: uid } });
      toast('Assigned to ' + picker.people()[0].name); router();
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
          ${d.can_cancel ? `<button class="btn danger" id="cancelBtn">Cancel request</button>` : ''}</div></div>
      ${d.take_blocked ? `<div class="card warn" style="margin-bottom:20px"><p style="margin:0">${esc(d.take_blocked)}</p></div>` : ''}
      ${r.status === 'needs_team' && !d.can_send_to_team ? `<div class="card" style="margin-bottom:20px"><p style="margin:0">No team was chosen for this request. A manager will send it to the right team.</p></div>` : ''}
      <div class="cols">
        <div class="stack">
          <section class="card">
            <dl class="meta-grid">
              <div><dt>Requested by</dt><dd>${esc(r.requested_by_name)}</dd></div>
              <div><dt>For team</dt><dd>${esc(r.team_name || (r.status === 'needs_team' ? 'Not decided yet' : '—'))}</dd></div>
              <div><dt>Posted</dt><dd>${fmtDate(r.created_at)}</dd></div>
              <div><dt>Taken by</dt><dd>${esc(r.assignee_name || '—')}</dd></div>
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
          <ul class="rows">${d.teams.map(t => `<li class="row-top"><span>${esc(t.name)}${t.lead_id ? '' : ' <span class="muted">· no lead</span>'}</span>
            <button class="btn ghost small" data-sendteam="${t.id}">Send</button></li>`).join('')}</ul></section>` : ''}
        ${d.can_assign ? `<section class="card"><h2>Assign to</h2><form id="assignForm">${assignPickerHtml(d)}</form></section>` : ''}
      </div>`;
    const act = async (path, body, msg) => { try { await api(`/requests/${r.id}/${path}`, { method: 'POST', body }); toast(msg); router(); } catch (e) { toast(e.message); } };
    if ($('#takeBtn')) $('#takeBtn').onclick = async () => {
      try { const x = await api(`/requests/${r.id}/take`, { method: 'POST' }); toast('The task is yours'); location.hash = '#/tasks/' + x.task_id; } catch (e) { toast(e.message); }
    };
    if ($('#recvBtn')) $('#recvBtn').onclick = () => act('received', undefined, 'Request closed');
    if ($('#cancelBtn')) $('#cancelBtn').onclick = () => { if (confirm('Cancel this request?')) act('cancel', undefined, 'Request cancelled'); };
    const asf = $('#assignForm');
    if (asf) {
      const picker = assignPicker(asf, d);
      if (picker) asf.onsubmit = e => {
        e.preventDefault();
        const [uid] = picker.values();
        if (!uid) { $('#assignErr').textContent = 'Choose a person.'; return; }
        act('assign', { user_id: uid }, 'Assigned to ' + picker.people()[0].name);
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
    const ALL = Object.assign({}, STATUS, { needs_team: 'Needs a team (request)', open: 'Open (request)', delivered: 'Delivered (request)', closed: 'Closed (request)', cancelled: 'Cancelled (request)' });
    const d = v => v ? fmtDate(v) : '<span class="muted">—</span>';
    const pill = r => r.type === 'request' ? reqPill(r) : `<span class="pill st-${esc(r.status)}">${STATUS[r.status] || esc(r.status)}</span>`;
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
          <td><a href="#/${r.type === 'request' ? 'requests' : 'tasks'}/${r.id}">${esc(r.title)}</a></td><td>${r.type === 'request' ? 'Request' : 'Task'}</td><td>${pill(r)}</td>
          <td>${esc(r.team_name || '—')}</td><td>${esc(r.assignee_name || '—')}</td><td>${esc(r.assigned_by_name || '—')}</td><td>${esc(r.requested_by_name || '—')}</td>
          <td>${d(r.assigned_at)}</td><td>${d(r.submitted_at)}</td><td>${d(r.approved_at)}</td><td>${d(r.completed_at)}</td>
          <td>${esc(r.approved_by_name || '—')}</td><td class="reasons">${esc(r.send_back_reasons || '')}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty">Nothing matches these filters.</div>`}`;
    if ($('#hPerson')) $('#hPerson').onchange = e => setQ('person', e.target.value);
    $('#hTeam').onchange = e => setQ('team', e.target.value);
    $('#hStatus').onchange = e => setQ('status', e.target.value);
    $('#hFrom').onchange = e => setQ('from', e.target.value);
    $('#hTo').onchange = e => setQ('to', e.target.value);
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

  router();
})();

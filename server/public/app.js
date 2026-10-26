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

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
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
    const items = [['#/', 'Dashboard'], ['#/tasks', me.role === 'employee' ? 'My tasks' : 'Tasks'], ['#/projects', 'Projects']];
    if (me.role !== 'employee') items.push(['#/people', isBoss() ? 'People' : 'My team']);
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
    renderNav(route);
    app.innerHTML = `<p class="muted">Loading…</p>`;
    const parts = route.split('?')[0].split('/');
    try {
      if (route === '') await viewDashboard();
      else if (parts[0] === 'tasks' && parts[1]) await viewTask(Number(parts[1]));
      else if (parts[0] === 'tasks') await viewTasks();
      else if (parts[0] === 'projects') await viewProjects();
      else if (parts[0] === 'people') await viewPeople();
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
          ${approvals}
          <section class="card"><h2>Due in the next 7 days</h2>${due}</section>
          <section class="card"><h2>This week</h2><p style="margin:0"><b style="font-size:1.5rem">${t.completed_week}</b> <span class="muted">tasks completed in the last 7 days</span></p></section>
        </div>
      </div>`;
    const nb = $('#newTask'); if (nb) nb.onclick = () => taskForm();
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

  async function taskForm(task) {
    const [{ projects }, { users }] = await Promise.all([api('/projects'), api('/users')]);
    const assignable = users.filter(u => u.active && (isBoss() || u.lead_id === me.id || u.id === me.id));
    if (!assignable.length) { toast(isBoss() ? 'Add people first, then assign tasks.' : 'No one is on your team yet. Ask a manager to add team members.'); return; }
    const t = task || { priority: 'medium' };
    openModal(`
      <h2 style="font-size:1.25rem">${task ? 'Edit task' : 'Assign a task'}</h2>
      <label class="f"><span>Title</span><input name="title" required maxlength="200" value="${esc(t.title)}"></label>
      <label class="f"><span>Description</span><textarea name="description" placeholder="What needs to be done, and what counts as finished">${esc(t.description)}</textarea></label>
      <div class="grid2">
        <label class="f"><span>Assign to</span><select name="assignee_id" required><option value="">Choose a person</option>
          ${assignable.map(u => `<option value="${u.id}"${u.id === t.assignee_id ? ' selected' : ''}>${esc(u.name)} (${ROLE[u.role]})</option>`).join('')}</select></label>
        <label class="f"><span>Project</span><select name="project_id"><option value="">No project</option>
          ${projects.filter(p => p.status !== 'closed' || p.id === t.project_id).map(p => `<option value="${p.id}"${p.id === t.project_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="f"><span>Priority</span><select name="priority">${options(PRIORITY, t.priority)}</select></label>
        <label class="f"><span>Deadline</span><input type="date" name="deadline" value="${esc(t.deadline || '')}"></label>
      </div>
      ${modalActions(task ? 'Save changes' : 'Assign task')}`,
      async fd => {
        const body = Object.fromEntries(fd);
        if (!body.title.trim()) throw new Error('Enter a task title.');
        if (!body.assignee_id) throw new Error('Choose who this task is for.');
        if (task) { await api('/tasks/' + task.id, { method: 'PATCH', body }); toast('Task updated'); }
        else { const r = await api('/tasks', { method: 'POST', body }); toast('Task assigned to ' + r.task.assignee_name); }
        router();
      });
  }

  // Status choices in the update form: "Completed" is only offered to people who may complete directly.
  function statusChoices(t, direct) {
    const c = { assigned: STATUS.assigned, in_progress: STATUS.in_progress };
    if (direct || t.status === 'completed') c.completed = STATUS.completed;
    return c;
  }

  // ---------- task detail ----------
  async function viewTask(id) {
    const { task: t, updates, can_edit, can_update, can_submit, can_review, can_complete_directly, locked } = await api('/tasks/' + id);
    const isAssignee = t.assignee_id === me.id;
    app.innerHTML = `
      <p style="margin:0 0 10px"><a href="#/tasks">← All tasks</a></p>
      <div class="page-head"><div><h1>${esc(t.title)}</h1><p>${statusPill(t)} <span style="margin-left:6px">${esc(dueText(t))}</span></p></div>
        ${can_edit ? `<div class="inline-actions"><button class="btn ghost" id="editTask">Edit</button><button class="btn danger" id="delTask">Delete</button></div>` : ''}</div>
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
            <p class="muted" style="margin-top:0">${esc(t.assignee_name)} submitted this task. Check the latest note in the activity, then approve it or send it back.</p>
            <div class="inline-actions"><button class="btn" id="approveBtn">Approve</button><button class="btn ghost" id="sendBackBtn">Send back</button></div></section>` : ''}
          ${locked && isAssignee ? `<section class="card"><p style="margin:0">Waiting for approval from ${esc(t.assigned_by_name)}. You can add comments, but status and progress are locked until it is approved or sent back.</p></section>` : ''}
          ${can_update ? `<section class="card"><h2>${locked ? 'Add a comment' : isAssignee ? 'Post an update' : 'Add a note or change status'}</h2>
            <form id="updForm">
              <label class="f"><span>${locked ? 'Comment' : 'What did you do? Any blockers?'}</span><textarea name="message" placeholder="${isAssignee ? 'For example: finished the login page, waiting for API access' : 'Add a note for the assignee'}"></textarea></label>
              ${locked ? '' : `<div class="grid2">
                <label class="f"><span>Status</span><select name="status">${options(statusChoices(t, can_complete_directly), t.status)}</select></label>
                <label class="f"><span>Progress</span><span class="progress-input"><input type="range" name="progress" min="0" max="100" step="5" value="${t.progress}"><output>${t.progress}%</output></span></label>
              </div>`}
              <p class="err" id="updErr"></p>
              <div class="inline-actions"><button class="btn">${locked ? 'Post comment' : 'Post update'}</button>
                ${can_submit ? `<button class="btn ghost" type="button" id="submitBtn">Submit for approval</button>` : ''}
                ${can_complete_directly ? `<button class="btn ghost" type="button" id="markDone">Mark as completed</button>` : ''}</div>
            </form></section>` : ''}
        </div>
        <section class="card"><h2>Activity</h2>
          <ul class="timeline">${updates.slice().reverse().map(u => `<li>
            <span class="who">${esc(u.user_name)}</span><span class="when">${fmtDateTime(u.created_at)}</span>
            <p>${esc(u.message)}${u.progress !== null && u.progress !== undefined ? ` <span class="muted">· ${u.progress}%</span>` : ''}</p></li>`).join('')}</ul>
        </section>
      </div>`;

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
      <p class="muted" style="margin-top:0">${esc(t.assigned_by_name)} will review your work and approve it or send it back.</p>
      <label class="f"><span>What was done?</span><textarea name="note" required maxlength="4000" placeholder="A short note about the finished work"></textarea></label>
      ${modalActions('Submit')}`, async fd => {
        const note = String(fd.get('note') || '').trim();
        if (!note) throw new Error('Write a short note about what was done.');
        await api(`/tasks/${t.id}/submit`, { method: 'POST', body: { note } }); toast('Submitted for approval'); router();
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
        const message = f.querySelector('[name=message]').value;
        if (!message.trim()) { $('#updErr').textContent = 'Write a comment first.'; return; }
        try { await api(`/tasks/${t.id}/updates`, { method: 'POST', body: { message } }); toast('Comment posted'); router(); }
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
        try { await api(`/tasks/${t.id}/updates`, { method: 'POST', body }); toast(body.status === 'completed' && t.status !== 'completed' ? 'Task completed' : 'Update posted'); router(); }
        catch (err) { $('#updErr').textContent = err.message; }
      };
      f.onsubmit = e => {
        e.preventDefault();
        const fd = new FormData(f);
        const body = { message: fd.get('message') };
        if (fd.get('status') !== t.status) body.status = fd.get('status');
        if (+fd.get('progress') !== t.progress) body.progress = +fd.get('progress');
        if (!body.message.trim() && body.status === undefined && body.progress === undefined) { $('#updErr').textContent = 'Write an update or change the progress.'; return; }
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
    const { users } = await api('/users');
    const byId = Object.fromEntries(users.map(u => [u.id, u]));
    const leads = users.filter(u => u.active && u.role !== 'employee');
    app.innerHTML = `
      <div class="page-head"><div><h1>${isBoss() ? 'People' : 'My team'}</h1><p>${isBoss() ? 'Add employees and set who they report to.' : 'People who report to you.'}</p></div>
        ${isBoss() ? `<button class="btn" id="newUser">Add a person</button>` : ''}</div>
      <div class="card table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Reports to</th><th>Status</th>${isBoss() ? '<th></th>' : ''}</tr></thead>
        <tbody>${users.map(u => `<tr>
          <td><a href="#/tasks?assignee=${u.id}">${esc(u.name)}</a></td><td>${esc(u.email)}</td><td>${ROLE[u.role]}</td>
          <td>${u.lead_id && byId[u.lead_id] ? esc(byId[u.lead_id].name) : '<span class="muted">—</span>'}</td>
          <td>${u.active ? 'Active' : '<span class="muted">Deactivated</span>'}</td>
          ${isBoss() ? `<td>${u.role === 'admin' && me.role !== 'admin' ? '' : `<button class="btn ghost small" data-edit="${u.id}">Edit</button>`}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
    if (!isBoss()) return;
    const roles = me.role === 'admin' ? ROLE : { manager: 'Manager', lead: 'Team lead', employee: 'Employee' };
    const form = u => openModal(`
      <h2 style="font-size:1.25rem">${u ? 'Edit ' + esc(u.name) : 'Add a person'}</h2>
      <div class="grid2">
        <label class="f"><span>Full name</span><input name="name" required value="${esc(u?.name)}"></label>
        <label class="f"><span>Email</span><input name="email" type="email" required value="${esc(u?.email)}"></label>
        <label class="f"><span>Role</span><select name="role">${options(roles, u?.role || 'employee')}</select></label>
        <label class="f"><span>Reports to</span><select name="lead_id"><option value="">No one</option>
          ${leads.filter(l => !u || l.id !== u.id).map(l => `<option value="${l.id}"${u && l.id === u.lead_id ? ' selected' : ''}>${esc(l.name)} (${ROLE[l.role]})</option>`).join('')}</select></label>
      </div>
      <label class="f"><span>${u ? 'New password (leave empty to keep current)' : 'Temporary password'}</span><input name="password" type="text" minlength="8" autocomplete="new-password" ${u ? '' : 'required'}></label>
      ${u && u.id !== me.id ? `<label class="f" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" style="width:auto" ${u.active ? 'checked' : ''}> Account active</label>` : ''}
      <p class="muted" style="font-size:.8125rem;margin-top:-4px">Team leads can assign tasks to the people who report to them.</p>
      ${modalActions(u ? 'Save changes' : 'Add person')}`,
      async fd => {
        const body = Object.fromEntries(fd);
        if (u && u.id !== me.id) body.active = fd.get('active') === 'on';
        if (u && !body.password) delete body.password;
        await api(u ? '/users/' + u.id : '/users', { method: u ? 'PATCH' : 'POST', body });
        toast(u ? 'Changes saved' : `${body.name} added. Share their email and temporary password with them.`); router();
      });
    $('#newUser').onclick = () => form();
    app.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(byId[b.dataset.edit]));
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

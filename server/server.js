const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_DAYS = 30;

app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
// Desktop app auto-update files (latest.yml, installers). Public, no sign-in; missing files are a plain 404.
app.use('/updates', express.static(path.join(__dirname, 'updates'), { fallthrough: false, index: false, maxAge: 0 }));
app.use('/updates', (err, req, res, next) => res.status(err.status || 404).type('text').send('Not found'));

// ---------- helpers ----------
const ROLES = ['admin', 'manager', 'lead', 'employee'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUSES = ['assigned', 'in_progress', 'submitted', 'completed'];
const isBoss = u => u.role === 'admin' || u.role === 'manager';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(res, msg, code = 400) { return res.status(code).json({ error: msg }); }
function str(v, max = 5000) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function optDate(v) { if (v === null || v === '' || v === undefined) return null; return DATE_RE.test(v) ? v : undefined; }
function publicUser(u) { return u && { id: u.id, name: u.name, email: u.email, role: u.role, lead_id: u.lead_id, active: !!u.active }; }

// Which tasks a user may see, as a SQL fragment on alias t.
function taskScope(u) {
  if (isBoss(u)) return { sql: '1=1', params: [] };
  if (u.role === 'lead') return {
    sql: '(t.assignee_id = ? OR t.assigned_by = ? OR t.assignee_id IN (SELECT id FROM users WHERE lead_id = ?))',
    params: [u.id, u.id, u.id]
  };
  return { sql: 't.assignee_id = ?', params: [u.id] };
}
function canSeeTask(u, task) {
  const s = taskScope(u);
  return !!db.prepare(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${s.sql}`).get(task.id, ...s.params);
}
function canEditTask(u, task) { return isBoss(u) || task.assigned_by === u.id; }
// Approval step: the assignee submits; the person who assigned the task, or any manager/admin, approves or sends back.
// Nobody reviews their own work. If someone assigned a task to themself they complete it directly.
function canReviewTask(u, task) { return u.id !== task.assignee_id && (isBoss(u) || task.assigned_by === u.id); }
function selfAssigned(task) { return task.assigned_by === task.assignee_id; }
// SQL fragment (alias t): submitted tasks the user may approve.
function reviewScope(u) {
  return isBoss(u) ? { sql: `t.status = 'submitted' AND t.assignee_id != ?`, params: [u.id] }
    : { sql: `t.status = 'submitted' AND t.assigned_by = ? AND t.assignee_id != ?`, params: [u.id, u.id] };
}
function canAssignTo(u, assignee) {
  if (!assignee || !assignee.active) return false;
  if (isBoss(u)) return true;
  if (u.role === 'lead') return assignee.lead_id === u.id || assignee.id === u.id;
  return false;
}

// ---------- auth ----------
const loginAttempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { n: 0, reset: now + 15 * 60e3 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 15 * 60e3; }
  rec.n++; loginAttempts.set(ip, rec);
  return rec.n > 10;
}

function auth(req, res, next) {
  const token = req.cookies.sid;
  if (!token) return bad(res, 'Please sign in.', 401);
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(token);
  if (!row) return bad(res, 'Your session has ended. Please sign in again.', 401);
  req.user = row;
  next();
}
function requireBoss(req, res, next) { return isBoss(req.user) ? next() : bad(res, 'Only managers and admins can do this.', 403); }

app.post('/api/login', (req, res) => {
  if (rateLimited(req.ip)) return bad(res, 'Too many sign-in attempts. Try again in 15 minutes.', 429);
  const email = str(req.body.email, 200), password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.active || !bcrypt.compareSync(password, user.password_hash)) return bad(res, 'Email or password is incorrect.', 401);
  loginAttempts.delete(req.ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,datetime('now', ?))`).run(token, user.id, `+${SESSION_DAYS} days`);
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: SESSION_DAYS * 864e5 });
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/me/password', auth, (req, res) => {
  const { current, next: nextPw } = req.body;
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return bad(res, 'Current password is incorrect.');
  if (typeof nextPw !== 'string' || nextPw.length < 8) return bad(res, 'New password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(nextPw, 10), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.cookies.sid);
  res.json({ ok: true });
});

// ---------- users ----------
app.get('/api/users', auth, (req, res) => {
  const u = req.user;
  let rows;
  if (isBoss(u)) rows = db.prepare('SELECT * FROM users ORDER BY active DESC, name').all();
  else if (u.role === 'lead') rows = db.prepare('SELECT * FROM users WHERE id = ? OR lead_id = ? ORDER BY name').all(u.id, u.id);
  else rows = [u];
  res.json({ users: rows.map(publicUser) });
});

app.post('/api/users', auth, requireBoss, (req, res) => {
  const name = str(req.body.name, 120), email = str(req.body.email, 200), role = req.body.role;
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const lead_id = req.body.lead_id ? Number(req.body.lead_id) : null;
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter a name and a valid email.');
  if (!ROLES.includes(role)) return bad(res, 'Choose a valid role.');
  if (role === 'admin' && req.user.role !== 'admin') return bad(res, 'Only an admin can create another admin.', 403);
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (lead_id && !db.prepare(`SELECT 1 FROM users WHERE id = ? AND role IN ('lead','manager','admin')`).get(lead_id)) return bad(res, 'Choose a valid team lead.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'A user with this email already exists.');
  const r = db.prepare('INSERT INTO users (name,email,password_hash,role,lead_id) VALUES (?,?,?,?,?)')
    .run(name, email, bcrypt.hashSync(password, 10), role, lead_id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
});

app.patch('/api/users/:id', auth, requireBoss, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return bad(res, 'User not found.', 404);
  if (target.role === 'admin' && req.user.role !== 'admin') return bad(res, 'Only an admin can change an admin account.', 403);
  const f = {};
  if (req.body.name !== undefined) { f.name = str(req.body.name, 120); if (!f.name) return bad(res, 'Name cannot be empty.'); }
  if (req.body.email !== undefined) {
    f.email = str(req.body.email, 200);
    if (!/^\S+@\S+\.\S+$/.test(f.email)) return bad(res, 'Enter a valid email.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(f.email, target.id)) return bad(res, 'A user with this email already exists.');
  }
  if (req.body.role !== undefined) {
    if (!ROLES.includes(req.body.role)) return bad(res, 'Choose a valid role.');
    if (req.body.role === 'admin' && req.user.role !== 'admin') return bad(res, 'Only an admin can grant admin access.', 403);
    f.role = req.body.role;
  }
  if (req.body.lead_id !== undefined) {
    f.lead_id = req.body.lead_id ? Number(req.body.lead_id) : null;
    if (f.lead_id === target.id) return bad(res, 'A user cannot be their own team lead.');
    if (f.lead_id && !db.prepare(`SELECT 1 FROM users WHERE id = ? AND role IN ('lead','manager','admin')`).get(f.lead_id)) return bad(res, 'Choose a valid team lead.');
  }
  if (req.body.active !== undefined) {
    if (target.id === req.user.id && !req.body.active) return bad(res, 'You cannot deactivate your own account.');
    f.active = req.body.active ? 1 : 0;
  }
  if (req.body.password) {
    if (String(req.body.password).length < 8) return bad(res, 'Password must be at least 8 characters.');
    f.password_hash = bcrypt.hashSync(String(req.body.password), 10);
  }
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => f[k]), target.id);
  if (f.active === 0 || f.password_hash) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) });
});

// ---------- projects ----------
app.get('/api/projects', auth, (req, res) => {
  const s = taskScope(req.user);
  const rows = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${s.sql}) AS total,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed' AND ${s.sql}) AS completed
    FROM projects p ORDER BY p.status = 'closed', p.name`).all(...s.params, ...s.params);
  res.json({ projects: rows });
});

app.post('/api/projects', auth, requireBoss, (req, res) => {
  const name = str(req.body.name, 160);
  if (!name) return bad(res, 'Enter a project name.');
  const r = db.prepare('INSERT INTO projects (name, description, created_by) VALUES (?,?,?)').run(name, str(req.body.description), req.user.id);
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid) });
});

app.patch('/api/projects/:id', auth, requireBoss, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
  if (!p) return bad(res, 'Project not found.', 404);
  const name = req.body.name !== undefined ? str(req.body.name, 160) : p.name;
  const description = req.body.description !== undefined ? str(req.body.description) : p.description;
  const status = req.body.status !== undefined ? req.body.status : p.status;
  if (!name) return bad(res, 'Project name cannot be empty.');
  if (!['active', 'on_hold', 'closed'].includes(status)) return bad(res, 'Choose a valid status.');
  db.prepare('UPDATE projects SET name = ?, description = ?, status = ? WHERE id = ?').run(name, description, status, p.id);
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id) });
});

// ---------- tasks ----------
const TASK_SELECT = `SELECT t.*, a.name AS assignee_name, b.name AS assigned_by_name, p.name AS project_name,
  CASE WHEN t.status != 'completed' AND t.deadline IS NOT NULL AND t.deadline < date('now','localtime') THEN 1 ELSE 0 END AS overdue
  FROM tasks t JOIN users a ON a.id = t.assignee_id JOIN users b ON b.id = t.assigned_by LEFT JOIN projects p ON p.id = t.project_id`;

app.get('/api/tasks', auth, (req, res) => {
  const s = taskScope(req.user);
  const where = [s.sql], params = [...s.params];
  const { status, project, assignee, mine } = req.query;
  if (status === 'overdue') where.push(`t.status != 'completed' AND t.deadline IS NOT NULL AND t.deadline < date('now','localtime')`);
  else if (status === 'open') where.push(`t.status != 'completed'`);
  else if (STATUSES.includes(status)) { where.push('t.status = ?'); params.push(status); }
  if (project) { where.push('t.project_id = ?'); params.push(Number(project)); }
  if (assignee) { where.push('t.assignee_id = ?'); params.push(Number(assignee)); }
  if (mine === 'assigned_by_me') { where.push('t.assigned_by = ?'); params.push(req.user.id); }
  const rows = db.prepare(`${TASK_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY t.status = 'completed', t.deadline IS NULL, t.deadline,
    CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.id DESC LIMIT 1000`).all(...params);
  res.json({ tasks: rows });
});

app.post('/api/tasks', auth, (req, res) => {
  const u = req.user;
  if (u.role === 'employee') return bad(res, 'Only managers and team leads can assign tasks.', 403);
  const title = str(req.body.title, 200);
  const assignee = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.body.assignee_id));
  const priority = req.body.priority || 'medium';
  const deadline = optDate(req.body.deadline), start_date = optDate(req.body.start_date);
  const project_id = req.body.project_id ? Number(req.body.project_id) : null;
  if (!title) return bad(res, 'Enter a task title.');
  if (!canAssignTo(u, assignee)) return bad(res, 'You can’t assign tasks to this person.', 403);
  if (!PRIORITIES.includes(priority)) return bad(res, 'Choose a valid priority.');
  if (deadline === undefined || start_date === undefined) return bad(res, 'Dates must be in YYYY-MM-DD format.');
  if (project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project_id)) return bad(res, 'Project not found.');
  const r = db.prepare(`INSERT INTO tasks (title, description, project_id, assignee_id, assigned_by, priority, start_date, deadline)
    VALUES (?,?,?,?,?,?,?,?)`).run(title, str(req.body.description), project_id, assignee.id, u.id, priority, start_date, deadline);
  db.prepare('INSERT INTO task_updates (task_id,user_id,message,status) VALUES (?,?,?,?)').run(r.lastInsertRowid, u.id, `Assigned to ${assignee.name}`, 'assigned');
  res.json({ task: db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(r.lastInsertRowid) });
});

app.get('/api/tasks/:id', auth, (req, res) => {
  const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(Number(req.params.id));
  if (!task || !canSeeTask(req.user, task)) return bad(res, 'Task not found.', 404);
  const updates = db.prepare(`SELECT up.*, u.name AS user_name FROM task_updates up JOIN users u ON u.id = up.user_id
    WHERE up.task_id = ? ORDER BY up.id`).all(task.id);
  const isAssignee = task.assignee_id === req.user.id;
  res.json({ task, updates, can_edit: canEditTask(req.user, task),
    can_update: isAssignee || canEditTask(req.user, task),
    can_submit: isAssignee && !selfAssigned(task) && ['assigned', 'in_progress'].includes(task.status),
    can_review: task.status === 'submitted' && canReviewTask(req.user, task),
    can_complete_directly: task.status !== 'completed' && task.status !== 'submitted' && (isAssignee ? selfAssigned(task) : canEditTask(req.user, task)),
    locked: task.status === 'submitted' });
});

app.patch('/api/tasks/:id', auth, (req, res) => {
  const u = req.user;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !canSeeTask(u, task)) return bad(res, 'Task not found.', 404);
  if (!canEditTask(u, task)) return bad(res, 'Only the person who assigned this task can edit it.', 403);
  const f = {}; const notes = [];
  if (req.body.title !== undefined) { f.title = str(req.body.title, 200); if (!f.title) return bad(res, 'Title cannot be empty.'); }
  if (req.body.description !== undefined) f.description = str(req.body.description);
  if (req.body.priority !== undefined) { if (!PRIORITIES.includes(req.body.priority)) return bad(res, 'Choose a valid priority.'); f.priority = req.body.priority; }
  for (const k of ['deadline', 'start_date']) if (req.body[k] !== undefined) {
    const d = optDate(req.body[k]); if (d === undefined) return bad(res, 'Dates must be in YYYY-MM-DD format.');
    if (k === 'deadline' && d !== task.deadline) notes.push(`Deadline changed to ${d || 'none'}`);
    f[k] = d;
  }
  if (req.body.project_id !== undefined) {
    f.project_id = req.body.project_id ? Number(req.body.project_id) : null;
    if (f.project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(f.project_id)) return bad(res, 'Project not found.');
  }
  if (req.body.assignee_id !== undefined && Number(req.body.assignee_id) !== task.assignee_id) {
    const a = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.body.assignee_id));
    if (!canAssignTo(u, a)) return bad(res, 'You can’t assign tasks to this person.', 403);
    f.assignee_id = a.id; notes.push(`Reassigned to ${a.name}`);
    if (task.status === 'submitted') { f.status = 'in_progress'; f.submitted_at = null; } // new person, so the old submission no longer applies
  }
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE tasks SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map(k => f[k]), task.id);
  for (const n of notes) db.prepare('INSERT INTO task_updates (task_id,user_id,message) VALUES (?,?,?)').run(task.id, u.id, n);
  res.json({ task: db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(task.id) });
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !canSeeTask(req.user, task)) return bad(res, 'Task not found.', 404);
  if (!canEditTask(req.user, task)) return bad(res, 'Only the person who assigned this task can delete it.', 403);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  res.json({ ok: true });
});

// Progress update / status change by the assignee (or the assigner)
app.post('/api/tasks/:id/updates', auth, (req, res) => {
  const u = req.user;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !canSeeTask(u, task)) return bad(res, 'Task not found.', 404);
  if (task.assignee_id !== u.id && !canEditTask(u, task)) return bad(res, 'Only the assignee can post updates on this task.', 403);
  const message = str(req.body.message, 4000);
  let status = req.body.status;
  let progress = req.body.progress === undefined || req.body.progress === '' ? null : Math.round(Number(req.body.progress));
  if (status !== undefined && !STATUSES.includes(status)) return bad(res, 'Choose a valid status.');
  if (status === 'submitted') return bad(res, 'Use “Submit for approval” to send this task for review.');
  if (progress !== null && (isNaN(progress) || progress < 0 || progress > 100)) return bad(res, 'Progress must be between 0 and 100.');
  if (!message && status === undefined && progress === null) return bad(res, 'Write an update or change the status.');
  if (task.status === 'submitted' && (status !== undefined || progress !== null)) {
    return bad(res, 'This task is waiting for approval. Status and progress can’t change until it is approved or sent back. You can still add a comment.', 409);
  }
  if (task.status === 'completed' && u.id === task.assignee_id && !selfAssigned(task) && (status !== undefined || progress !== null)) {
    return bad(res, 'This task has been approved and completed. You can still add a comment.', 409);
  }
  if (status === 'completed' && task.status !== 'completed') {
    const direct = u.id === task.assignee_id ? selfAssigned(task) : canEditTask(u, task);
    if (!direct) return bad(res, 'Tasks must be submitted for approval before they can be completed.', 403);
  }
  if (status === 'completed') progress = 100;
  if (status === undefined && progress !== null && progress > 0 && task.status === 'assigned') status = 'in_progress';
  if (status === 'in_progress' && progress === 100) progress = 99;

  const newStatus = status || task.status;
  const newProgress = progress !== null ? progress : (newStatus === 'completed' ? 100 : task.progress);
  const completedAt = newStatus === 'completed' ? (task.completed_at || new Date().toISOString()) : null;
  const approvedBy = newStatus === 'completed' ? (task.status === 'completed' ? task.approved_by : u.id) : null;
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET status = ?, progress = ?, completed_at = ?, approved_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(newStatus, newProgress, completedAt, approvedBy, task.id);
    const autoMsg = newStatus !== task.status ? ({ assigned: 'Moved back to not started', in_progress: 'Started work', completed: 'Marked as completed' })[newStatus] : '';
    db.prepare('INSERT INTO task_updates (task_id,user_id,message,progress,status) VALUES (?,?,?,?,?)')
      .run(task.id, u.id, message || autoMsg || 'Progress updated', progress, newStatus !== task.status ? newStatus : null);
  })();
  res.json({ task: db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(task.id) });
});

// Approval step ---------------------------------------------------------------
function loadVisibleTask(req, res) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !canSeeTask(req.user, task)) { bad(res, 'Task not found.', 404); return null; }
  return task;
}
function taskResponse(res, id) { res.json({ task: db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) }); }

// Assignee sends finished work for approval (a note is required).
app.post('/api/tasks/:id/submit', auth, (req, res) => {
  const u = req.user, task = loadVisibleTask(req, res); if (!task) return;
  if (task.assignee_id !== u.id) return bad(res, 'Only the person this task is assigned to can submit it.', 403);
  if (selfAssigned(task)) return bad(res, 'You assigned this task to yourself, so you can mark it completed directly.');
  if (task.status === 'submitted') return bad(res, 'This task is already waiting for approval.', 409);
  if (task.status === 'completed') return bad(res, 'This task is already completed.', 409);
  const note = str(req.body.note, 4000);
  if (!note) return bad(res, 'Write a short note about what was done.');
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET status = 'submitted', submitted_at = ?, approved_by = NULL, completed_at = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(new Date().toISOString(), task.id);
    db.prepare('INSERT INTO task_updates (task_id,user_id,message,progress,status) VALUES (?,?,?,?,?)')
      .run(task.id, u.id, 'Submitted for approval: ' + note, task.progress, 'submitted');
  })();
  taskResponse(res, task.id);
});

// Assigner or any manager/admin approves: task becomes completed.
app.post('/api/tasks/:id/approve', auth, (req, res) => {
  const u = req.user, task = loadVisibleTask(req, res); if (!task) return;
  if (!canReviewTask(u, task)) return bad(res, 'Only the person who assigned this task, or a manager, can approve it.', 403);
  if (task.status !== 'submitted') return bad(res, 'This task isn’t waiting for approval.', 409);
  const note = str(req.body.note, 4000);
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET status = 'completed', progress = 100, completed_at = ?, approved_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(new Date().toISOString(), u.id, task.id);
    db.prepare('INSERT INTO task_updates (task_id,user_id,message,progress,status) VALUES (?,?,?,?,?)')
      .run(task.id, u.id, 'Approved' + (note ? ': ' + note : ''), 100, 'completed');
  })();
  taskResponse(res, task.id);
});

// Reviewer sends it back for more work (a reason is required).
app.post('/api/tasks/:id/send-back', auth, (req, res) => {
  const u = req.user, task = loadVisibleTask(req, res); if (!task) return;
  if (!canReviewTask(u, task)) return bad(res, 'Only the person who assigned this task, or a manager, can send it back.', 403);
  if (task.status !== 'submitted') return bad(res, 'This task isn’t waiting for approval.', 409);
  const reason = str(req.body.reason, 4000);
  if (!reason) return bad(res, 'Write a reason so the assignee knows what to fix.');
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET status = 'in_progress', progress = MIN(progress, 99), submitted_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(task.id);
    db.prepare('INSERT INTO task_updates (task_id,user_id,message,status) VALUES (?,?,?,?)')
      .run(task.id, u.id, 'Sent back: ' + reason, 'in_progress');
  })();
  taskResponse(res, task.id);
});

// ---------- desktop app summary ----------
// Open tasks assigned to the signed-in person: used for the desktop icon badge and new-task notifications.
app.get('/api/my-summary', auth, (req, res) => {
  const u = req.user;
  const OVERDUE = `status != 'completed' AND deadline IS NOT NULL AND deadline < date('now','localtime')`;
  const counts = db.prepare(`SELECT COUNT(*) AS open, SUM(${OVERDUE}) AS overdue
    FROM tasks WHERE assignee_id = ? AND status != 'completed'`).get(u.id);
  // Own open tasks, with their status. A task that was sent back also carries the reason.
  const tasks = db.prepare(`SELECT t.id, t.title, t.deadline, t.priority, t.status, b.name AS assigned_by_name,
      CASE WHEN t.status = 'in_progress' THEN (SELECT substr(message, 12) FROM task_updates
        WHERE task_id = t.id AND message LIKE 'Sent back: %' ORDER BY id DESC LIMIT 1) END AS sent_back_reason
    FROM tasks t JOIN users b ON b.id = t.assigned_by
    WHERE t.assignee_id = ? AND t.status != 'completed' ORDER BY t.id DESC LIMIT 100`).all(u.id);
  // Own tasks approved in the last 3 days (so the app can say "was approved").
  const recently_approved = db.prepare(`SELECT id, title FROM tasks WHERE assignee_id = ? AND status = 'completed'
    AND approved_by IS NOT NULL AND completed_at >= ? ORDER BY completed_at DESC LIMIT 50`)
    .all(u.id, new Date(Date.now() - 3 * 864e5).toISOString());
  // Tasks waiting for this person's approval.
  const rs = reviewScope(u);
  const approvals = db.prepare(`SELECT t.id, t.title, t.deadline, t.priority, t.submitted_at, a.name AS assignee_name
    FROM tasks t JOIN users a ON a.id = t.assignee_id WHERE ${rs.sql} ORDER BY t.submitted_at LIMIT 100`).all(...rs.params);
  res.json({ user: publicUser(u), open: counts.open || 0, overdue: counts.overdue || 0, tasks, recently_approved, approvals });
});

// ---------- dashboard ----------
app.get('/api/dashboard', auth, (req, res) => {
  const s = taskScope(req.user);
  const OVERDUE = `t.status != 'completed' AND t.deadline IS NOT NULL AND t.deadline < date('now','localtime')`;
  const totals = db.prepare(`SELECT COUNT(*) AS total,
      SUM(t.status = 'completed') AS completed,
      SUM(t.status = 'in_progress') AS in_progress,
      SUM(t.status = 'submitted') AS submitted,
      SUM(t.status = 'assigned') AS not_started,
      SUM(${OVERDUE}) AS overdue,
      SUM(t.status = 'completed' AND date(t.completed_at) >= date('now','localtime','-6 days')) AS completed_week
    FROM tasks t WHERE ${s.sql}`).get(...s.params);
  for (const k in totals) totals[k] = totals[k] || 0;

  const projects = db.prepare(`SELECT p.id, p.name, p.status, COUNT(t.id) AS total,
      SUM(t.status = 'completed') AS completed, SUM(${OVERDUE}) AS overdue
    FROM projects p JOIN tasks t ON t.project_id = p.id AND ${s.sql}
    GROUP BY p.id ORDER BY p.status = 'closed', p.name`).all(...s.params);

  const people = db.prepare(`SELECT u.id, u.name, u.role, COUNT(t.id) AS total,
      SUM(t.status = 'completed') AS completed, SUM(t.status = 'in_progress') AS in_progress, SUM(t.status = 'submitted') AS submitted,
      SUM(t.status = 'assigned') AS not_started, SUM(${OVERDUE}) AS overdue
    FROM tasks t JOIN users u ON u.id = t.assignee_id WHERE ${s.sql}
    GROUP BY u.id ORDER BY u.name`).all(...s.params);

  const due_soon = db.prepare(`${TASK_SELECT} WHERE ${s.sql} AND t.status != 'completed' AND t.deadline IS NOT NULL
      AND t.deadline <= date('now','localtime','+7 days') ORDER BY t.deadline LIMIT 10`).all(...s.params);

  const rs = reviewScope(req.user);
  const awaiting_me = db.prepare(`${TASK_SELECT} WHERE ${rs.sql} ORDER BY t.submitted_at LIMIT 50`).all(...rs.params);

  res.json({ totals, projects, people, due_soon, awaiting_me });
});

app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`TaskDesk running on http://localhost:${PORT}`));

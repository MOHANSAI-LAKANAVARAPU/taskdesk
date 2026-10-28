const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_DAYS = 30;
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');

app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
// Pages, script and styles must be revalidated on every load so browsers and the desktop app never run stale code
// after a server update (ETags keep it cheap: unchanged files answer 304).
const noCache = res => res.set('Cache-Control', 'no-cache');
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => { if (/\.(html|js|css)$/.test(file)) noCache(res); }
}));
// Build id: a hash of the server code and the pages, so it changes exactly when a new version is deployed.
// The desktop app compares it on every check and reloads the dashboard when it changes.
const BUILD_ID = (() => {
  const h = crypto.createHash('sha1');
  const add = f => { try { h.update(f + '\0' + fs.readFileSync(f)); } catch (e) { /* missing file */ } };
  for (const f of ['server.js', 'db.js', 'package.json']) add(path.join(__dirname, f));
  const pub = path.join(__dirname, 'public');
  for (const f of fs.readdirSync(pub).sort()) add(path.join(pub, f));
  return h.digest('hex').slice(0, 12);
})();
app.get('/api/version', (req, res) => { noCache(res); res.json({ build: BUILD_ID }); });
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
function publicUser(u) {
  if (!u) return u;
  const team = u.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(u.team_id) : null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, lead_id: u.lead_id, team_id: u.team_id || null,
    team_name: team ? team.name : null, active: !!u.active };
}
// Teams: a lead manages the members of the teams where teams.lead_id = them (users.lead_id is no longer used).
const LED_MEMBERS = '(SELECT m.id FROM users m JOIN teams tm ON tm.id = m.team_id WHERE tm.lead_id = ?)';
const LED_REQUEST_TASKS = '(SELECT r.task_id FROM requests r JOIN teams tm ON tm.id = r.target_team_id WHERE tm.lead_id = ? AND r.task_id IS NOT NULL)';
function isMemberOfLedTeam(u, other) {
  return !!(other && other.team_id && db.prepare('SELECT 1 FROM teams WHERE id = ? AND lead_id = ?').get(other.team_id, u.id));
}
function validTeamLead(id) {
  return !!db.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1 AND role IN ('lead','manager','admin')`).get(id);
}

// Which tasks a user may see, as a SQL fragment on alias t. Archived (deleted) tasks only with `archived` (History).
function taskScope(u, archived = false) {
  const live = archived ? '' : ' AND t.deleted_at IS NULL';
  if (isBoss(u)) return { sql: '1=1' + live, params: [] };
  if (u.role === 'lead') return {
    sql: `(t.assignee_id = ? OR t.assigned_by = ? OR t.assignee_id IN ${LED_MEMBERS} OR t.id IN ${LED_REQUEST_TASKS})${live}`,
    params: [u.id, u.id, u.id, u.id]
  };
  return { sql: 't.assignee_id = ?' + live, params: [u.id] };
}
function canSeeTask(u, task) {
  const s = taskScope(u);
  return !!db.prepare(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${s.sql}`).get(task.id, ...s.params);
}
// Edit/delete: managers/admins and the assigner. A self-claimed request task (assigned_by = assignee) can't be edited
// or deleted by the claimer (they use "Give back"); the request team's lead can instead.
// A request sent to a person ("Ask a person") is handled like a self-claimed one: the target team's lead (not the
// requester) edits and approves it, and the person can give it back.
function canEditTask(u, task) {
  if (isBoss(u)) return true;
  const r = linkedRequest(task.id);
  if (r && (task.assigned_by === task.assignee_id || isPersonTask(task, r))) return r.team_lead_id === u.id;
  return task.assigned_by === u.id;
}
function isPersonTask(task, r) { return !!(r && r.asked_person_id && r.task_id === task.id && r.asked_person_id === task.assignee_id); }
function isClaimer(u, task) {
  if (task.assignee_id !== u.id) return false;
  const r = linkedRequest(task.id);
  return !!r && (task.assigned_by === u.id || isPersonTask(task, r));
}
const GIVE_BACK_HINT = 'You took this from a document request. Use “Give back” to return it to the team.';
// Approval step: the assignee submits; reviewers approve or send back. Nobody reviews their own work.
// Reviewers: managers/admins; the person in assigned_by (when that isn't the assignee); and for a self-claimed
// document request (assigned_by = assignee) the lead of the request's target team. Nobody else.
function linkedRequest(taskId) {
  return db.prepare(`SELECT r.*, tm.lead_id AS team_lead_id FROM requests r LEFT JOIN teams tm ON tm.id = r.target_team_id
    WHERE r.task_id = ?`).get(taskId);
}
// A person request is approved by the person's team lead or a manager/admin, never by the requester.
function canReviewTask(u, task) {
  const r = linkedRequest(task.id), person = isPersonTask(task, r);
  if (person && r.requested_by === u.id && u.id !== task.assignee_id) return false;
  if (isBoss(u)) return true; // managers/admins: any submitted task, including their own (recorded as self-approved)
  if (u.id === task.assignee_id) return false;
  if (task.assigned_by !== task.assignee_id && !person) return task.assigned_by === u.id;
  return !!(r && r.team_lead_id === u.id);
}
// A plain task someone assigned to themself: they complete it directly. A self-claimed request task still needs approval.
function ownPlainTask(task) { return task.assigned_by === task.assignee_id && !linkedRequest(task.id); }
// SQL fragment (alias t): submitted tasks the user may approve.
const PERSON_TASKS = '(SELECT pr.task_id FROM requests pr JOIN tasks pt ON pt.id = pr.task_id WHERE pr.asked_person_id = pt.assignee_id)';
const MY_PERSON_ASKS = '(SELECT pr.task_id FROM requests pr JOIN tasks pt ON pt.id = pr.task_id WHERE pr.asked_person_id = pt.assignee_id AND pr.requested_by = ? AND pt.assignee_id != pr.requested_by)';
function reviewScope(u) {
  return isBoss(u) ? { sql: `t.status = 'submitted' AND t.deleted_at IS NULL AND t.id NOT IN ${MY_PERSON_ASKS}`, params: [u.id] }
    : { sql: `t.status = 'submitted' AND t.deleted_at IS NULL AND t.assignee_id != ? AND ((t.assigned_by = ? AND t.assigned_by != t.assignee_id AND t.id NOT IN ${PERSON_TASKS})
        OR ((t.assigned_by = t.assignee_id OR t.id IN ${PERSON_TASKS}) AND t.id IN ${LED_REQUEST_TASKS} AND t.id NOT IN ${MY_PERSON_ASKS}))`,
      params: [u.id, u.id, u.id, u.id] };
}
// Who can actually approve a task (same rules as canReviewTask): the assigner if they aren't the assignee, otherwise
// for a self-claimed request the target team's lead; plus any active manager/admin who isn't the assignee (`any_manager`),
// and the assignee themself if they are a manager/admin (`self`).
// For a person request (`request.asked_person_id` = the assignee): the person's team lead and managers/admins, never the requester.
function approversFor(assigneeId, assignedBy, request) {
  const active = id => db.prepare('SELECT name FROM users WHERE id = ? AND active = 1').get(id);
  const person = !!(request && request.asked_person_id && request.asked_person_id === assigneeId);
  const requester = person ? request.requested_by : 0;
  const names = [];
  if (assignedBy !== assigneeId && !person) { const a = active(assignedBy); if (a) names.push(a.name); }
  else if (request && request.team_lead_id && request.team_lead_id !== assigneeId && request.team_lead_id !== requester) {
    const l = active(request.team_lead_id); if (l) names.push(l.name);
  }
  const any_manager = !!db.prepare(`SELECT 1 FROM users WHERE active = 1 AND role IN ('admin','manager') AND id NOT IN (?, ?)`).get(assigneeId, requester);
  // A manager/admin assignee can always approve their own work, so the "nobody can approve" block never applies to them.
  const self = !!db.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1 AND role IN ('admin','manager')`).get(assigneeId);
  return { names, any_manager, self, nobody: !names.length && !any_manager && !self };
}
// `assigneeId`: who would do the work. A team lead's own request task can only be approved by a manager/admin.
function nobodyCanApprove(request, assigneeId) {
  if (request && request.team_lead_id && request.team_lead_id === assigneeId)
    return `Nobody can approve this yet: work the lead of ${request.team_name} takes is approved by a manager. Ask an admin to add a manager.`;
  return request && request.team_name ? `Nobody can approve this yet. Ask a manager to set a lead for ${request.team_name}.`
    : 'Nobody can approve this yet. Ask a manager to add another manager or team lead.';
}
function linkedRequestFull(taskId) { return db.prepare(`${REQ_SELECT} WHERE r.task_id = ?`).get(taskId); }

// When a task linked to a document request is completed, the request is delivered (and undone if the task is reopened).
function syncRequestWithTask(taskId, newStatus, oldStatus) {
  if (newStatus === 'completed' && oldStatus !== 'completed') {
    db.prepare(`UPDATE requests SET status = 'delivered', delivered_at = ? WHERE task_id = ? AND status = 'assigned'`).run(new Date().toISOString(), taskId);
  } else if (newStatus !== 'completed' && oldStatus === 'completed') {
    db.prepare(`UPDATE requests SET status = 'assigned', delivered_at = NULL WHERE task_id = ? AND status = 'delivered'`).run(taskId);
  }
}
function canAssignTo(u, assignee) {
  if (!assignee || !assignee.active) return false;
  if (isBoss(u)) return true;
  if (u.role === 'lead') return assignee.id === u.id || isMemberOfLedTeam(u, assignee);
  return false;
}


// ---------- file uploads ----------
// Files are stored in data/uploads/ under random names; the original name is kept in the files table.
const MAX_FILE_MB = 25;
const FILE_TYPES = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'
};
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')) }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 5, fields: 20, fieldSize: 64 * 1024, parts: 30 },
  fileFilter: (req, file, cb) => {
    if (FILE_TYPES[path.extname(file.originalname || '').toLowerCase()]) return cb(null, true);
    const e = new Error(`“${cleanFileName(file.originalname)}” isn’t an allowed file type. Use PDF, Word, Excel, PowerPoint, images, text or ZIP.`);
    e.userMessage = true; cb(e);
  }
});
function cleanFileName(name) {
  let n = String(name || 'file');
  // Browsers send UTF-8 names; busboy may read them as latin1.
  if (/[À-ÿ]/.test(n)) { const u = Buffer.from(n, 'latin1').toString('utf8'); if (!u.includes('�')) n = u; }
  n = path.basename(n.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (n || 'file').slice(0, 200);
}
// Parses multipart bodies (field "files"); JSON requests pass straight through. Any error response removes the stored files.
function withUploads(req, res, next) {
  res.on('finish', () => { if (res.statusCode >= 400) discardUploads(req); });
  if (!req.is('multipart/form-data')) return next();
  upload.array('files', 5)(req, res, err => {
    if (!err) return next();
    discardUploads(req);
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each file must be ${MAX_FILE_MB} MB or smaller.`
      : err.code === 'LIMIT_FILE_COUNT' ? 'You can attach up to 5 files at a time.'
      : err.userMessage ? err.message : 'The upload failed. Try again.';
    bad(res, msg);
  });
}
function discardUploads(req) {
  for (const f of req.files || []) fs.unlink(f.path, () => {});
  req.files = [];
}
function removeStoredFiles(rows) {
  for (const r of rows) if (/^[0-9a-f]{32}$/.test(r.stored_name)) fs.unlink(path.join(UPLOAD_DIR, r.stored_name), () => {});
}
function saveUploads(req, link) {
  const ins = db.prepare(`INSERT INTO files (original_name, stored_name, size, mime, uploaded_by, task_id, update_id, request_id, message_id)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const f of req.files || []) {
    const name = cleanFileName(f.originalname);
    ins.run(name, f.filename, f.size, FILE_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
      req.user.id, link.task_id || null, link.update_id || null, link.request_id || null, link.message_id || null);
  }
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
  else if (u.role === 'lead') rows = db.prepare(`SELECT * FROM users WHERE id = ? OR id IN ${LED_MEMBERS} ORDER BY name`).all(u.id, u.id);
  else rows = [u];
  res.json({ users: rows.map(publicUser) });
});

app.post('/api/users', auth, requireBoss, (req, res) => {
  const name = str(req.body.name, 120), email = str(req.body.email, 200), role = req.body.role;
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const lead_id = req.body.lead_id ? Number(req.body.lead_id) : null;
  const team_id = req.body.team_id ? Number(req.body.team_id) : null;
  if (team_id && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(team_id)) return bad(res, 'Choose a valid team.');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter a name and a valid email.');
  if (!ROLES.includes(role)) return bad(res, 'Choose a valid role.');
  if (role === 'admin' && req.user.role !== 'admin') return bad(res, 'Only an admin can create another admin.', 403);
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (lead_id && !db.prepare(`SELECT 1 FROM users WHERE id = ? AND role IN ('lead','manager','admin')`).get(lead_id)) return bad(res, 'Choose a valid team lead.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'A user with this email already exists.');
  const r = db.prepare('INSERT INTO users (name,email,password_hash,role,lead_id,team_id) VALUES (?,?,?,?,?,?)')
    .run(name, email, bcrypt.hashSync(password, 10), role, lead_id, team_id);
  const became_lead = autoLead(r.lastInsertRowid);
  syncTeamChats();
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)), became_lead });
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
  if (req.body.team_id !== undefined) {
    f.team_id = req.body.team_id ? Number(req.body.team_id) : null;
    if (f.team_id && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(f.team_id)) return bad(res, 'Choose a valid team.');
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
  if (f.role === 'employee' || f.active === 0) db.prepare('UPDATE teams SET lead_id = NULL WHERE lead_id = ?').run(target.id); // can no longer lead a team
  // Only when the team or the role changed (a manager may have cleared the team's lead on purpose).
  const became_lead = (f.team_id !== undefined && f.team_id !== target.team_id) || (f.role !== undefined && f.role !== target.role) ? autoLead(target.id) : null;
  syncTeamChats(); // team chats follow team membership, leads and deactivation
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)), became_lead });
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

// Create tasks: one separate task per person in assignee_ids (or the single assignee_id, kept for compatibility).
// Every person is checked with canAssignTo first; if anyone isn't allowed, nothing is created.
app.post('/api/tasks', auth, (req, res) => {
  const u = req.user;
  if (u.role === 'employee') return bad(res, 'Only managers and team leads can assign tasks.', 403);
  const title = str(req.body.title, 200);
  const rawIds = Array.isArray(req.body.assignee_ids) ? req.body.assignee_ids : req.body.assignee_id ? [req.body.assignee_id] : [];
  const ids = [...new Set(rawIds.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 200);
  const priority = req.body.priority || 'medium';
  const deadline = optDate(req.body.deadline), start_date = optDate(req.body.start_date);
  const project_id = req.body.project_id ? Number(req.body.project_id) : null;
  if (!title) return bad(res, 'Enter a task title.');
  if (!ids.length) return bad(res, 'Choose at least one person.');
  const people = ids.map(id => ({ id, user: db.prepare('SELECT * FROM users WHERE id = ?').get(id) }));
  const refused = people.filter(p => !canAssignTo(u, p.user)).map(p => p.user ? p.user.name : `unknown person #${p.id}`);
  if (refused.length) return bad(res, `You can’t assign tasks to ${refused.join(', ')}. No tasks were created.`, 403);
  if (!PRIORITIES.includes(priority)) return bad(res, 'Choose a valid priority.');
  if (deadline === undefined || start_date === undefined) return bad(res, 'Dates must be in YYYY-MM-DD format.');
  if (project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project_id)) return bad(res, 'Project not found.');
  const description = str(req.body.description);
  const created = db.transaction(() => people.map(({ user: a }) => {
    const id = db.prepare(`INSERT INTO tasks (title, description, project_id, assignee_id, assigned_by, priority, start_date, deadline)
      VALUES (?,?,?,?,?,?,?,?)`).run(title, description, project_id, a.id, u.id, priority, start_date, deadline).lastInsertRowid;
    db.prepare('INSERT INTO task_updates (task_id,user_id,message,status) VALUES (?,?,?,?)').run(id, u.id, `Assigned to ${a.name}`, 'assigned');
    return id;
  }))();
  const tasks = created.map(id => db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id));
  res.json({ task: tasks[0], tasks, count: tasks.length });
});

app.get('/api/tasks/:id', auth, (req, res) => {
  const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(Number(req.params.id));
  if (!task || !canSeeTask(req.user, task)) return bad(res, 'Task not found.', 404);
  const updates = db.prepare(`SELECT up.*, u.name AS user_name FROM task_updates up JOIN users u ON u.id = up.user_id
    WHERE up.task_id = ? ORDER BY up.id`).all(task.id);
  const files = db.prepare('SELECT id, original_name, size, update_id, uploaded_by, created_at FROM files WHERE task_id = ? ORDER BY id').all(task.id);
  for (const up of updates) up.files = files.filter(f => f.update_id === up.id);
  const lr = linkedRequestFull(task.id);
  const isAssignee = task.assignee_id === req.user.id;
  const approvers = ownPlainTask(task) ? null : approversFor(task.assignee_id, task.assigned_by, lr);
  res.json({ task, updates, can_edit: canEditTask(req.user, task), approvers,
    can_give_back: isClaimer(req.user, task) && ['assigned', 'in_progress'].includes(task.status) && lr && lr.status === 'assigned',
    approval_blocked: approvers && approvers.nobody && task.status !== 'completed' ? nobodyCanApprove(lr, task.assignee_id) : null,
    can_update: isAssignee || canEditTask(req.user, task),
    can_submit: isAssignee && !ownPlainTask(task) && ['assigned', 'in_progress'].includes(task.status),
    can_review: task.status === 'submitted' && canReviewTask(req.user, task),
    can_complete_directly: task.status !== 'completed' && task.status !== 'submitted' && (isAssignee ? ownPlainTask(task) || isBoss(req.user) : canEditTask(req.user, task) && !(isPersonTask(task, lr) && lr.requested_by === req.user.id)),
    locked: task.status === 'submitted',
    files, request: lr ? { id: lr.id, title: lr.title, status: lr.status } : null });
});

app.patch('/api/tasks/:id', auth, (req, res) => {
  const u = req.user;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !canSeeTask(u, task)) return bad(res, 'Task not found.', 404);
  if (!canEditTask(u, task)) return bad(res, isClaimer(u, task) ? GIVE_BACK_HINT : 'Only the person who assigned this task can edit it.', 403);
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
    // A self-claimed request task now belongs to someone else: the person reassigning becomes its assigner.
    const lr = linkedRequest(task.id);
    if (lr && (task.assigned_by === task.assignee_id || isPersonTask(task, lr))) f.assigned_by = u.id;
    if (isPersonTask(task, lr)) db.prepare('UPDATE requests SET asked_person_id = NULL WHERE id = ?').run(lr.id);
    if (task.status === 'submitted') { // new person, so the old submission no longer applies
      f.status = 'in_progress'; f.submitted_at = null; notes.push(`Moved back to in progress for ${a.name}`);
    }
  }
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE tasks SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map(k => f[k]), task.id);
  for (const n of notes) db.prepare('INSERT INTO task_updates (task_id,user_id,message) VALUES (?,?,?)').run(task.id, u.id, n);
  res.json({ task: db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(task.id) });
});

// Archive a task (Delete, Give back, Withdraw) instead of removing it: the row and its files stay, hidden everywhere
// except History, until a manager restores it or deletes it permanently. `requestId`: the request it was linked to.
function archiveTask(taskId, u, requestId) {
  db.prepare(`UPDATE tasks SET deleted_at = ?, deleted_by = ?, archived_request_id = ? WHERE id = ?`)
    .run(new Date().toISOString(), u.id, requestId || null, taskId);
}
app.delete('/api/tasks/:id', auth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !canSeeTask(req.user, task)) return bad(res, 'Task not found.', 404);
  if (!canEditTask(req.user, task)) return bad(res, isClaimer(req.user, task) ? GIVE_BACK_HINT : 'Only the person who assigned this task can delete it.', 403);
  const lr = linkedRequest(task.id);
  if (lr && ['delivered', 'closed'].includes(lr.status)) return bad(res, 'This task delivered a document request, so it can’t be deleted.', 409);
  db.transaction(() => {
    if (lr) db.prepare(`UPDATE requests SET status = 'open', task_id = NULL, asked_person_id = NULL WHERE id = ? AND status = 'assigned'`).run(lr.id); // back on the board
    archiveTask(task.id, req.user, lr && lr.id);
  })();
  res.json({ ok: true });
});

// The claimer of a self-claimed request (or the person a request was sent to) hands it back: the task is archived and the request is open again.
// Not allowed once submitted or completed. Team members are notified again because it reappears among open requests.
app.post('/api/tasks/:id/give-back', auth, (req, res) => {
  const u = req.user;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !canSeeTask(u, task)) return bad(res, 'Task not found.', 404);
  if (!isClaimer(u, task)) return bad(res, 'Only the person who took this request, or was asked to do it, can give it back.', 403);
  if (!['assigned', 'in_progress'].includes(task.status)) return bad(res, 'This task has been submitted or completed, so it can’t be given back.', 409);
  const lr = linkedRequest(task.id);
  if (!lr || lr.status !== 'assigned') return bad(res, 'This request can’t be given back now.', 409);
  db.transaction(() => {
    db.prepare(`UPDATE requests SET status = 'open', task_id = NULL, asked_person_id = NULL WHERE id = ? AND status = 'assigned'`).run(lr.id);
    db.prepare('INSERT INTO request_events (request_id, user_id, message) VALUES (?,?,?)').run(lr.id, u.id, `${u.name} gave the request back`);
    archiveTask(task.id, u, lr.id);
  })();
  res.json({ ok: true, request_id: lr.id });
});

// Progress update / status change by the assignee (or the assigner); may carry attached files.
function canPostUpdate(req, res, next) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !canSeeTask(req.user, task)) return bad(res, 'Task not found.', 404);
  if (task.assignee_id !== req.user.id && !canEditTask(req.user, task)) return bad(res, 'Only the assignee can post updates on this task.', 403);
  next();
}
app.post('/api/tasks/:id/updates', auth, canPostUpdate, withUploads, (req, res) => {
  const u = req.user;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  const message = str(req.body.message, 4000);
  let status = req.body.status;
  let progress = req.body.progress === undefined || req.body.progress === '' ? null : Math.round(Number(req.body.progress));
  if (status !== undefined && !STATUSES.includes(status)) return bad(res, 'Choose a valid status.');
  if (status === 'submitted') return bad(res, 'Use “Submit for approval” to send this task for review.');
  if (progress !== null && (isNaN(progress) || progress < 0 || progress > 100)) return bad(res, 'Progress must be between 0 and 100.');
  const hasFiles = !!(req.files && req.files.length);
  if (!message && status === undefined && progress === null && !hasFiles) return bad(res, 'Write an update, change the status or attach a file.');
  if (task.status === 'submitted' && (status !== undefined || progress !== null)) {
    return bad(res, 'This task is waiting for approval. Status and progress can’t change until it is approved or sent back. You can still add a comment.', 409);
  }
  if (task.status === 'completed' && u.id === task.assignee_id && !ownPlainTask(task) && !isBoss(u) && (status !== undefined || progress !== null)) {
    return bad(res, 'This task has been approved and completed. You can still add a comment.', 409);
  }
  if (status === 'completed' && task.status !== 'completed') {
    const lr = linkedRequest(task.id); // the requester of a person request never completes it themself
    const direct = u.id === task.assignee_id ? ownPlainTask(task) || isBoss(u) : canEditTask(u, task) && !(isPersonTask(task, lr) && lr.requested_by === u.id);
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
    // A manager/admin completing their own (non-plain) task approves it themselves.
    const selfApproved = newStatus === 'completed' && task.status !== 'completed' && u.id === task.assignee_id && !ownPlainTask(task) && isBoss(u);
    const up = db.prepare('INSERT INTO task_updates (task_id,user_id,message,progress,status) VALUES (?,?,?,?,?)')
      .run(task.id, u.id, selfApproved ? `Self-approved by ${u.name}` + (message ? ': ' + message : '') : message || autoMsg || (hasFiles && status === undefined && progress === null ? 'Attached files' : 'Progress updated'), progress, newStatus !== task.status ? newStatus : null);
    saveUploads(req, { task_id: task.id, update_id: up.lastInsertRowid });
    syncRequestWithTask(task.id, newStatus, task.status);
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
function canSubmit(req, res, next) {
  const task = loadVisibleTask(req, res); if (!task) return;
  if (task.assignee_id !== req.user.id) return bad(res, 'Only the person this task is assigned to can submit it.', 403);
  next();
}
app.post('/api/tasks/:id/submit', auth, canSubmit, withUploads, (req, res) => {
  const u = req.user, task = loadVisibleTask(req, res); if (!task) return;
  if (task.assignee_id !== u.id) return bad(res, 'Only the person this task is assigned to can submit it.', 403);
  if (ownPlainTask(task)) return bad(res, 'You assigned this task to yourself, so you can mark it completed directly.');
  const lr = linkedRequestFull(task.id);
  if (approversFor(task.assignee_id, task.assigned_by, lr).nobody) return bad(res, nobodyCanApprove(lr, task.assignee_id), 409);
  if (task.status === 'submitted') return bad(res, 'This task is already waiting for approval.', 409);
  if (task.status === 'completed') return bad(res, 'This task is already completed.', 409);
  const note = str(req.body.note, 4000);
  if (!note) return bad(res, 'Write a short note about what was done.');
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET status = 'submitted', submitted_at = ?, approved_by = NULL, completed_at = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(new Date().toISOString(), task.id);
    const up = db.prepare('INSERT INTO task_updates (task_id,user_id,message,progress,status) VALUES (?,?,?,?,?)')
      .run(task.id, u.id, 'Submitted for approval: ' + note, task.progress, 'submitted');
    saveUploads(req, { task_id: task.id, update_id: up.lastInsertRowid });
  })();
  taskResponse(res, task.id);
});

// Why canReviewTask said no ("approve" / "send back").
function reviewRefusal(u, task, verb) {
  if (u.id === task.assignee_id) return `You can’t ${verb} your own work.`;
  const doIt = verb === 'send back' ? 'send it back' : verb + ' it';
  const r = linkedRequest(task.id);
  if (isPersonTask(task, r) && r.requested_by === u.id) return `You asked for this, so the lead of the person’s team or another manager has to ${doIt}.`;
  return `Only the person who assigned this task, the request team’s lead or a manager can ${doIt}.`;
}
// A reviewer (see canReviewTask) approves: task becomes completed (and a linked request is delivered).
// A manager/admin approving their own task is logged as "Self-approved by <name>".
app.post('/api/tasks/:id/approve', auth, (req, res) => {
  const u = req.user, task = loadVisibleTask(req, res); if (!task) return;
  if (!canReviewTask(u, task)) return bad(res, reviewRefusal(u, task, 'approve'), 403);
  if (task.status !== 'submitted') return bad(res, 'This task isn’t waiting for approval.', 409);
  const note = str(req.body.note, 4000);
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET status = 'completed', progress = 100, completed_at = ?, approved_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(new Date().toISOString(), u.id, task.id);
    db.prepare('INSERT INTO task_updates (task_id,user_id,message,progress,status) VALUES (?,?,?,?,?)')
      .run(task.id, u.id, (u.id === task.assignee_id ? `Self-approved by ${u.name}` : 'Approved') + (note ? ': ' + note : ''), 100, 'completed');
    syncRequestWithTask(task.id, 'completed', task.status);
  })();
  taskResponse(res, task.id);
});

// Reviewer sends it back for more work (a reason is required).
app.post('/api/tasks/:id/send-back', auth, (req, res) => {
  const u = req.user, task = loadVisibleTask(req, res); if (!task) return;
  if (!canReviewTask(u, task)) return bad(res, reviewRefusal(u, task, 'send back'), 403);
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

// ---------- teams ----------
// Teams are a company directory: everyone sees every team and its members. Open task/request counts only for
// the team's lead and managers/admins.
const canSeeTeamCounts = (u, t) => isBoss(u) || t.lead_id === u.id;
const OPEN_TEAM_TASKS = `(SELECT COUNT(*) FROM tasks t JOIN users m ON m.id = t.assignee_id WHERE m.team_id = tm.id AND t.status != 'completed' AND t.deleted_at IS NULL)`;
const OPEN_TEAM_REQUESTS = `(SELECT COUNT(*) FROM requests r WHERE r.target_team_id = tm.id AND r.status = 'open' AND r.deleted_at IS NULL)`;
const TEAM_SELECT = `SELECT tm.*, l.name AS lead_name, (SELECT COUNT(*) FROM users m WHERE m.team_id = tm.id AND m.active = 1) AS member_count,
  ${OPEN_TEAM_TASKS} AS open_tasks, ${OPEN_TEAM_REQUESTS} AS open_requests FROM teams tm LEFT JOIN users l ON l.id = tm.lead_id`;
// Connected teams ("works with"): two-way, each pair stored once with the smaller id first.
function connectedTeams(teamId) {
  return db.prepare(`SELECT tm.id, tm.name FROM team_connections c JOIN teams tm ON tm.id = CASE WHEN c.team_a_id = ? THEN c.team_b_id ELSE c.team_a_id END
    WHERE ? IN (c.team_a_id, c.team_b_id) ORDER BY tm.name`).all(teamId, teamId);
}
function teamView(u, t) {
  const v = { id: t.id, name: t.name, lead_id: t.lead_id, lead_name: t.lead_name, member_count: t.member_count, mine: u.team_id === t.id,
    can_see_counts: canSeeTeamCounts(u, t), connections: connectedTeams(t.id) };
  if (v.can_see_counts) { v.open_tasks = t.open_tasks; v.open_requests = t.open_requests; }
  return v;
}
app.get('/api/teams', auth, (req, res) => res.json({ teams: db.prepare(`${TEAM_SELECT} ORDER BY tm.name`).all().map(t => teamView(req.user, t)) }));
app.get('/api/teams/:id', auth, (req, res) => {
  const u = req.user, t = db.prepare(`${TEAM_SELECT} WHERE tm.id = ?`).get(Number(req.params.id));
  if (!t) return bad(res, 'Team not found.', 404);
  const team = teamView(u, t);
  const members = db.prepare(`SELECT m.id, m.name, m.role, m.email, m.active,
      (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = m.id AND t.status != 'completed' AND t.deleted_at IS NULL) AS open_tasks
    FROM users m WHERE m.team_id = ? ${isBoss(u) ? '' : 'AND m.active = 1'} ORDER BY m.active DESC, m.id = ? DESC, m.name`).all(t.id, t.lead_id || 0)
    .map(m => { const x = { ...m, active: !!m.active, is_lead: m.id === t.lead_id }; if (!team.can_see_counts) delete x.open_tasks; return x; });
  const lead = t.lead_id ? db.prepare('SELECT id, name, role, email, team_id FROM users WHERE id = ?').get(t.lead_id) : null;
  res.json({ team, lead, members, can_manage: isBoss(u), can_assign: canSeeTeamCounts(u, t) });
});
// A user with role "lead" who joins a team without a lead becomes its lead (setting the role and the team's lead used
// to be two separate steps that were easy to miss). Returns { team_id, team_name } when it happened.
function autoLead(userId) {
  const m = db.prepare(`SELECT us.name, tm.id AS team_id, tm.name AS team_name FROM users us JOIN teams tm ON tm.id = us.team_id
    WHERE us.id = ? AND us.active = 1 AND us.role = 'lead' AND tm.lead_id IS NULL`).get(userId);
  if (!m || !db.prepare('UPDATE teams SET lead_id = ? WHERE id = ? AND lead_id IS NULL').run(userId, m.team_id).changes) return null;
  return { team_id: m.team_id, team_name: m.team_name, name: m.name };
}

function teamFields(req, res, current) {
  const name = req.body.name !== undefined ? str(req.body.name, 120) : current && current.name;
  if (!name) { bad(res, 'Enter a team name.'); return null; }
  if (db.prepare('SELECT 1 FROM teams WHERE name = ? AND id != ?').get(name, current ? current.id : 0)) { bad(res, 'A team with this name already exists.'); return null; }
  let lead_id = current ? current.lead_id : null;
  if (req.body.lead_id !== undefined) {
    lead_id = req.body.lead_id ? Number(req.body.lead_id) : null;
    if (lead_id && !validTeamLead(lead_id)) { bad(res, 'The team lead must be an active team lead, manager or admin.'); return null; }
  }
  return { name, lead_id };
}
app.post('/api/teams', auth, requireBoss, (req, res) => {
  const f = teamFields(req, res); if (!f) return;
  const r = db.prepare('INSERT INTO teams (name, lead_id) VALUES (?, ?)').run(f.name, f.lead_id);
  syncTeamChats();
  res.json({ team: db.prepare('SELECT * FROM teams WHERE id = ?').get(r.lastInsertRowid) });
});
app.patch('/api/teams/:id', auth, requireBoss, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
  if (!team) return bad(res, 'Team not found.', 404);
  const f = teamFields(req, res, team); if (!f) return;
  db.prepare('UPDATE teams SET name = ?, lead_id = ? WHERE id = ?').run(f.name, f.lead_id, team.id);
  syncTeamChats();
  res.json({ team: db.prepare('SELECT * FROM teams WHERE id = ?').get(team.id) });
});
app.delete('/api/teams/:id', auth, requireBoss, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
  if (!team) return bad(res, 'Team not found.', 404);
  const active = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE target_team_id = ? AND status IN ('open','assigned','delivered')`).get(team.id).n;
  if (active) return bad(res, `This team has ${active} unfinished document request${active === 1 ? '' : 's'}. Finish or cancel them first.`, 409);
  const chat = db.prepare(`SELECT id FROM conversations WHERE type = 'team' AND team_id = ?`).get(team.id);
  db.transaction(() => {
    // The team's chat is archived: its members keep reading it, nobody can post.
    db.prepare(`UPDATE conversations SET archived_at = datetime('now'), name = name || ' (team deleted)' WHERE type = 'team' AND team_id = ?`).run(team.id);
    db.prepare('UPDATE users SET team_id = NULL WHERE team_id = ?').run(team.id);
    db.prepare('DELETE FROM team_connections WHERE ? IN (team_a_id, team_b_id)').run(team.id);
    db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
  })();
  if (chat) push(memberIds(chat.id), 'conversation', { conversation_id: chat.id });
  res.json({ ok: true });
});
// Add (or move) a person into a team / remove them. A person belongs to one team.
function memberTarget(req, res) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.userId));
  if (!team || !user) { bad(res, 'Team or person not found.', 404); return null; }
  if (user.role === 'admin' && req.user.role !== 'admin') { bad(res, 'Only an admin can change an admin account.', 403); return null; }
  return { team, user };
}
app.put('/api/teams/:id/members/:userId', auth, requireBoss, (req, res) => {
  const t = memberTarget(req, res); if (!t) return;
  db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(t.team.id, t.user.id);
  const became_lead = autoLead(t.user.id);
  syncTeamChats();
  res.json({ ok: true, became_lead });
});
// Managers/admins: the full list of teams this team works with (replaces the old list).
app.put('/api/teams/:id/connections', auth, requireBoss, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
  if (!team) return bad(res, 'Team not found.', 404);
  const ids = [...new Set((Array.isArray(req.body.team_ids) ? req.body.team_ids : []).map(Number))].filter(id => id !== team.id);
  if (ids.some(id => !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id))) return bad(res, 'Choose valid teams.');
  db.transaction(() => {
    db.prepare('DELETE FROM team_connections WHERE ? IN (team_a_id, team_b_id)').run(team.id);
    const add = db.prepare('INSERT INTO team_connections (team_a_id, team_b_id, created_by) VALUES (?,?,?)');
    for (const id of ids) add.run(Math.min(id, team.id), Math.max(id, team.id), req.user.id);
  })();
  res.json({ connections: connectedTeams(team.id) });
});
app.delete('/api/teams/:id/members/:userId', auth, requireBoss, (req, res) => {
  const t = memberTarget(req, res); if (!t) return;
  db.prepare('UPDATE users SET team_id = NULL WHERE id = ? AND team_id = ?').run(t.user.id, t.team.id);
  syncTeamChats();
  res.json({ ok: true });
});

// ---------- document requests ----------
// Status is validated here (no CHECK constraint in the database).
// needs_team: posted without a team ("Not sure, let a manager decide"); a manager sends it to a team, which makes it open.
const REQ_STATUSES = ['needs_team', 'open', 'assigned', 'delivered', 'closed', 'cancelled'];
const REQ_SELECT = `SELECT r.*, rb.name AS requested_by_name, rb.team_id AS requester_team_id, rt.name AS requester_team_name,
  rt.lead_id AS requester_lead_id, tm.name AS team_name, tm.lead_id AS team_lead_id,
  t.assignee_id, a.name AS assignee_name, t.status AS task_status, ap.name AS asked_person_name, wf.name AS withdrawn_from_name
  FROM requests r JOIN users rb ON rb.id = r.requested_by LEFT JOIN teams rt ON rt.id = rb.team_id LEFT JOIN teams tm ON tm.id = r.target_team_id
  LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users ap ON ap.id = r.asked_person_id LEFT JOIN users wf ON wf.id = r.withdrawn_from_id`;
// Archived (deleted) requests are only reachable from History (getAnyRequest).
function getRequest(id) { return db.prepare(`${REQ_SELECT} WHERE r.id = ? AND r.deleted_at IS NULL`).get(id); }
function getAnyRequest(id) { return db.prepare(`${REQ_SELECT} WHERE r.id = ?`).get(id); }
// Who may see a request (board, page, files, History): managers/admins, the requester, members and the lead of the
// requester's team, members and the lead of the target team, and the person doing (or who was doing) it.
function canSeeRequest(u, r) {
  return isBoss(u) || r.requested_by === u.id || (!!u.team_id && (u.team_id === r.requester_team_id || u.team_id === r.target_team_id))
    || r.requester_lead_id === u.id || r.team_lead_id === u.id || r.assignee_id === u.id || r.withdrawn_from_id === u.id;
}
const canSeeRequestFiles = canSeeRequest;
// The same rule as SQL on alias r.
function requestScope(u, archived = false) {
  const live = archived ? '' : ' AND r.deleted_at IS NULL';
  if (isBoss(u)) return { sql: '1=1' + live, params: [] };
  const team = u.team_id || 0;
  return { sql: `(r.requested_by = ? OR r.requested_by IN (SELECT id FROM users WHERE team_id = ?) OR r.target_team_id = ?
      OR r.requested_by IN ${LED_MEMBERS} OR r.target_team_id IN (SELECT id FROM teams WHERE lead_id = ?) OR r.withdrawn_from_id = ?
      OR r.task_id IN (SELECT id FROM tasks WHERE assignee_id = ?))${live}`, params: [u.id, team, team, u.id, u.id, u.id, u.id] };
}
// Teams a user may send requests to: their own team and the teams connected to it (managers/admins: any team).
function allowedTargetTeams(u) {
  if (isBoss(u)) return db.prepare('SELECT id, name FROM teams ORDER BY name').all();
  if (!u.team_id) return [];
  return db.prepare('SELECT id, name FROM teams WHERE id = ?').all(u.team_id).concat(connectedTeams(u.team_id))
    .sort((a, b) => a.name.localeCompare(b.name));
}
// People a user may ask directly: active members of those teams, not themself.
function askablePeople(u) {
  const ids = allowedTargetTeams(u).map(t => t.id);
  if (!ids.length) return [];
  return db.prepare(`SELECT us.id, us.name, us.role, us.team_id, tm.name AS team_name FROM users us JOIN teams tm ON tm.id = us.team_id
    WHERE us.active = 1 AND us.id != ? AND us.team_id IN (${ids.map(() => '?').join(',')}) ORDER BY us.team_id != ?, tm.name, us.name`)
    .all(u.id, ...ids, u.team_id || 0);
}
// Members of the request's team, its lead (even when not a member) and managers/admins can take an open request.
function canTakeRequest(u, r) {
  return isBoss(u) || (!!u.team_id && u.team_id === r.target_team_id) || (!!r.team_lead_id && r.team_lead_id === u.id);
}
// The requester takes back a request someone is already doing, until it has been submitted or delivered.
function canWithdraw(u, r) { return r.status === 'assigned' && r.requested_by === u.id && ['assigned', 'in_progress'].includes(r.task_status); }
function requestFlags(u, r) {
  const can_take = r.status === 'open' && canTakeRequest(u, r);
  return {
    can_take,
    take_blocked: can_take && approversFor(u.id, u.id, r).nobody ? nobodyCanApprove(r, u.id) : null,
    can_send_to_team: r.status === 'needs_team' && isBoss(u),
    can_assign: r.status === 'open' && !!r.target_team_id && (isBoss(u) || r.team_lead_id === u.id),
    can_cancel: ['open', 'needs_team'].includes(r.status) && (r.requested_by === u.id || isBoss(u)),
    can_withdraw: canWithdraw(u, r),
    can_delete: isBoss(u) && ['needs_team', 'open', 'cancelled', 'closed'].includes(r.status),
    can_receive: r.status === 'delivered' && r.requested_by === u.id,
    can_attach: ['needs_team', 'open', 'assigned'].includes(r.status) && (r.requested_by === u.id || isBoss(u)),
    can_see_files: canSeeRequestFiles(u, r)
  };
}

app.get('/api/requests', auth, (req, res) => {
  const scope = requestScope(req.user);
  const where = [scope.sql], params = [...scope.params];
  if (req.query.team) { where.push('r.target_team_id = ?'); params.push(Number(req.query.team)); }
  if (req.query.status === 'active') where.push(`r.status IN ('needs_team','open','assigned','delivered')`);
  else if (REQ_STATUSES.includes(req.query.status)) { where.push('r.status = ?'); params.push(req.query.status); }
  const rows = db.prepare(`${REQ_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY CASE r.status WHEN 'needs_team' THEN 0 WHEN 'open' THEN 1 WHEN 'assigned' THEN 2 WHEN 'delivered' THEN 3 ELSE 4 END,
      r.needed_by IS NULL, r.needed_by, r.id DESC LIMIT 1000`).all(...params);
  res.json({ requests: rows.map(r => ({ id: r.id, title: r.title, requested_by: r.requested_by, requested_by_name: r.requested_by_name,
    target_team_id: r.target_team_id, team_name: r.team_name, needed_by: r.needed_by, status: r.status, assignee_name: r.assignee_name,
    asked_person_name: r.asked_person_name, created_at: r.created_at })) });
});
// The New request form: teams this user may send to, and people they may ask.
app.get('/api/request-targets', auth, (req, res) => res.json({ teams: allowedTargetTeams(req.user), people: askablePeople(req.user) }));

app.get('/api/requests/:id', auth, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r || !canSeeRequest(u, r)) return bad(res, 'Request not found.', 404);
  const flags = requestFlags(u, r);
  const fileCols = 'id, original_name, size, uploaded_by, created_at';
  const files = flags.can_see_files ? db.prepare(`SELECT ${fileCols} FROM files WHERE request_id = ? ORDER BY id`).all(r.id) : [];
  const delivered = flags.can_see_files && r.task_id && ['delivered', 'closed'].includes(r.status)
    ? db.prepare(`SELECT ${fileCols} FROM files WHERE task_id = ? ORDER BY id`).all(r.task_id) : [];
  // Assign list: the team's members for its lead; every active person (with their team) for managers/admins.
  const members = !flags.can_assign ? [] : isBoss(u)
    ? db.prepare(`SELECT us.id, us.name, us.role, us.team_id, tm.name AS team_name FROM users us LEFT JOIN teams tm ON tm.id = us.team_id
        WHERE us.active = 1 ORDER BY us.team_id IS NOT ?, tm.name IS NULL, tm.name, us.name`).all(r.target_team_id)
    : db.prepare(`SELECT us.id, us.name, us.role, us.team_id, tm.name AS team_name FROM users us LEFT JOIN teams tm ON tm.id = us.team_id
        WHERE us.team_id = ? AND us.active = 1 ORDER BY us.name`).all(r.target_team_id);
  const task = r.task_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.task_id) : null;
  const teams = flags.can_send_to_team ? db.prepare('SELECT id, name, lead_id FROM teams ORDER BY name').all() : [];
  const events = db.prepare(`SELECT e.message, e.created_at, us.name AS user_name FROM request_events e JOIN users us ON us.id = e.user_id
    WHERE e.request_id = ? ORDER BY e.id`).all(r.id);
  res.json({ request: r, ...flags, files, delivered_files: delivered, members, teams, events, can_open_task: !!(task && canSeeTask(u, task)) });
});

app.post('/api/requests', auth, withUploads, (req, res) => {
  const u = req.user;
  const title = str(req.body.title, 200), description = str(req.body.description), needed_by = optDate(req.body.needed_by);
  if (!title) return bad(res, 'Enter a title for the request.');
  if (needed_by === undefined) return bad(res, 'Dates must be in YYYY-MM-DD format.');
  // "Ask a person": created already assigned to that person (a linked task with assigned_by = the requester).
  if (req.body.person_id) {
    const p = db.prepare(`SELECT us.*, tm.name AS team_name, tm.lead_id AS team_lead_id FROM users us LEFT JOIN teams tm ON tm.id = us.team_id
      WHERE us.id = ?`).get(Number(req.body.person_id));
    if (!p || !p.active) return bad(res, 'Choose an active person.');
    if (p.id === u.id) return bad(res, 'You can’t send a request to yourself. Add a task for yourself instead.');
    if (!p.team_id) return bad(res, `${p.name} isn’t in a team yet, so they can’t be asked directly.`);
    if (!allowedTargetTeams(u).some(t => t.id === p.team_id))
      return bad(res, `You can only ask people in your own team or in teams connected to it. ${p.team_name} isn’t one of them.`, 403);
    const pseudo = { asked_person_id: p.id, requested_by: u.id, team_lead_id: p.team_lead_id, team_name: p.team_name };
    if (approversFor(p.id, u.id, pseudo).nobody) return bad(res, nobodyCanApprove(pseudo, p.id), 409);
    let id;
    db.transaction(() => {
      id = db.prepare(`INSERT INTO requests (title, description, needed_by, requested_by, target_team_id, status, asked_person_id)
        VALUES (?,?,?,?,?,'assigned',?)`).run(title, description, needed_by, u.id, p.team_id, p.id).lastInsertRowid;
      const desc = [description, `Document request #${id} from ${u.name}, sent to you.`].filter(Boolean).join('\n\n');
      const taskId = db.prepare('INSERT INTO tasks (title, description, assignee_id, assigned_by, deadline) VALUES (?,?,?,?,?)')
        .run(title, desc, p.id, u.id, needed_by).lastInsertRowid;
      db.prepare('UPDATE requests SET task_id = ? WHERE id = ?').run(taskId, id);
      db.prepare('INSERT INTO task_updates (task_id,user_id,message,status) VALUES (?,?,?,?)').run(taskId, u.id, `${u.name} asked ${p.name} (document request #${id})`, 'assigned');
      db.prepare('INSERT INTO request_events (request_id, user_id, message) VALUES (?,?,?)').run(id, u.id, `Sent to ${p.name} by ${u.name}`);
      saveUploads(req, { request_id: id });
    })();
    return res.json({ request: getRequest(id) });
  }
  // No team ("Not sure, let a manager decide") -> needs_team; a manager picks the team later.
  const noTeam = !req.body.target_team_id || req.body.target_team_id === 'none';
  const team = noTeam ? null : db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.body.target_team_id));
  if (!noTeam && !team) return bad(res, 'Choose a valid team, or “Not sure, let a manager decide”.');
  if (team && !allowedTargetTeams(u).some(t => t.id === team.id)) return bad(res, u.team_id
    ? `You can send requests to your own team and to teams connected to it. ${team.name} isn’t one of them – ask a manager, or choose “Not sure, let a manager decide”.`
    : 'You aren’t in a team yet, so choose “Not sure, let a manager decide”.', 403);
  let id;
  db.transaction(() => {
    id = db.prepare('INSERT INTO requests (title, description, needed_by, requested_by, target_team_id, status) VALUES (?,?,?,?,?,?)')
      .run(title, description, needed_by, u.id, team ? team.id : null, team ? 'open' : 'needs_team').lastInsertRowid;
    saveUploads(req, { request_id: id });
  })();
  res.json({ request: getRequest(id) });
});

// Add attachments to an open request (requester or manager).
function canAttachToRequest(req, res, next) {
  const r = getRequest(Number(req.params.id));
  if (!r) return bad(res, 'Request not found.', 404);
  if (!requestFlags(req.user, r).can_attach) return bad(res, 'Only the person who made this request can add files to it.', 403);
  next();
}
app.post('/api/requests/:id/files', auth, canAttachToRequest, withUploads, (req, res) => {
  if (!req.files || !req.files.length) return bad(res, 'Choose at least one file.');
  saveUploads(req, { request_id: Number(req.params.id) });
  res.json({ ok: true });
});

// Turn an open request into a task assigned to `assignee` (assigned_by = `by`). Only one claim can win.
function createRequestTask(r, assignee, by) {
  return db.transaction(() => {
    const desc = [r.description, `Document request #${r.id} from ${r.requested_by_name}${r.team_name ? ' for ' + r.team_name : ''}.`].filter(Boolean).join('\n\n');
    const taskId = db.prepare(`INSERT INTO tasks (title, description, assignee_id, assigned_by, deadline) VALUES (?,?,?,?,?)`)
      .run(r.title, desc, assignee.id, by.id, r.needed_by).lastInsertRowid;
    const claimed = db.prepare(`UPDATE requests SET status = 'assigned', task_id = ? WHERE id = ? AND status = 'open'`).run(taskId, r.id);
    if (!claimed.changes) { const e = new Error('Someone else has already taken this request.'); e.status = 409; throw e; }
    db.prepare('INSERT INTO task_updates (task_id,user_id,message,status) VALUES (?,?,?,?)').run(taskId, by.id,
      assignee.id === by.id ? `Took document request #${r.id}` : `Assigned from document request #${r.id} to ${assignee.name}`, 'assigned');
    return taskId;
  })();
}
function sendRequestTask(res, r, assignee, by) {
  try { const taskId = createRequestTask(r, assignee, by); res.json({ request: getRequest(r.id), task_id: taskId }); }
  catch (e) { if (e.status) return bad(res, e.message, e.status); throw e; }
}
app.post('/api/requests/:id/take', auth, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r) return bad(res, 'Request not found.', 404);
  if (r.status === 'needs_team') return bad(res, 'A manager hasn’t chosen a team for this request yet.', 409);
  if (r.status !== 'open') return bad(res, 'This request has already been taken.', 409);
  if (!canTakeRequest(u, r)) return bad(res, 'Only members of the team this request is for, its lead and managers can take it.', 403);
  if (approversFor(u.id, u.id, r).nobody) return bad(res, nobodyCanApprove(r, u.id), 409);
  sendRequestTask(res, r, u, u);
});
app.post('/api/requests/:id/assign', auth, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r) return bad(res, 'Request not found.', 404);
  if (r.status === 'needs_team') return bad(res, 'Send this request to a team first.', 409);
  if (!isBoss(u) && r.team_lead_id !== u.id) return bad(res, 'Only managers and the team’s lead can assign this request.', 403);
  if (r.status !== 'open') return bad(res, 'This request has already been taken.', 409);
  const a = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.body.user_id));
  if (!a || !a.active) return bad(res, 'Choose an active person.');
  // Managers: anyone. The lead: the team's members, or themself (same as "Take this task").
  if (!isBoss(u) && a.id !== u.id && a.team_id !== r.target_team_id) return bad(res, 'Choose an active member of the request’s team.');
  if (approversFor(a.id, u.id, r).nobody) return bad(res, nobodyCanApprove(r, a.id), 409);
  sendRequestTask(res, r, a, u);
});
// Withdraw: the requester takes back a request someone is already doing (not yet submitted). The task is archived
// (kept with its files, shown in History) and the request is cancelled; the person (and their team's lead) are told by the desktop app.
app.post('/api/requests/:id/withdraw', auth, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r || !canSeeRequest(u, r)) return bad(res, 'Request not found.', 404);
  if (r.requested_by !== u.id) return bad(res, 'Only the person who made this request can withdraw it.', 403);
  if (!canWithdraw(u, r)) return bad(res, r.status === 'assigned' ? 'The work has already been submitted for approval, so it can’t be withdrawn.'
    : 'Only a request someone is working on can be withdrawn.', 409);
  const done = db.transaction(() => { // re-checked inside the transaction: the work may have been submitted meanwhile
    const ok = db.prepare(`UPDATE requests SET status = 'cancelled', closed_at = ?, task_id = NULL, withdrawn_from_id = ?
      WHERE id = ? AND status = 'assigned' AND task_id = ? AND (SELECT status FROM tasks WHERE id = ?) IN ('assigned','in_progress')`)
      .run(new Date().toISOString(), r.assignee_id, r.id, r.task_id, r.task_id);
    if (!ok.changes) return false;
    db.prepare('INSERT INTO request_events (request_id, user_id, message) VALUES (?,?,?)').run(r.id, u.id, `${u.name} withdrew the request`);
    archiveTask(r.task_id, u, r.id);
    return true;
  })();
  if (!done) return bad(res, 'The work has already been submitted for approval, so it can’t be withdrawn.', 409);
  res.json({ request: getRequest(r.id) });
});
app.post('/api/requests/:id/cancel', auth, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r) return bad(res, 'Request not found.', 404);
  if (r.requested_by !== u.id && !isBoss(u)) return bad(res, 'Only the person who made this request, or a manager, can cancel it.', 403);
  if (!['open', 'needs_team'].includes(r.status)) return bad(res, 'Only requests nobody has taken yet can be cancelled.', 409);
  db.prepare(`UPDATE requests SET status = 'cancelled', closed_at = ? WHERE id = ? AND status IN ('open','needs_team')`).run(new Date().toISOString(), r.id);
  res.json({ request: getRequest(r.id) });
});
// A manager/admin chooses the team for a request posted without one; from then on it is a normal open request.
app.post('/api/requests/:id/send-to-team', auth, requireBoss, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r) return bad(res, 'Request not found.', 404);
  if (r.status !== 'needs_team') return bad(res, 'This request already has a team.', 409);
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.body.team_id));
  if (!team) return bad(res, 'Choose a team.');
  db.transaction(() => {
    const ok = db.prepare(`UPDATE requests SET target_team_id = ?, status = 'open' WHERE id = ? AND status = 'needs_team'`).run(team.id, r.id);
    if (!ok.changes) return;
    db.prepare('INSERT INTO request_events (request_id, user_id, message) VALUES (?,?,?)').run(r.id, u.id, `Sent to ${team.name} by ${u.name}`);
  })();
  res.json({ request: getRequest(r.id) });
});
app.post('/api/requests/:id/received', auth, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r) return bad(res, 'Request not found.', 404);
  if (r.requested_by !== u.id) return bad(res, 'Only the person who made this request can mark it as received.', 403);
  if (r.status !== 'delivered') return bad(res, 'This request hasn’t been delivered yet.', 409);
  db.prepare(`UPDATE requests SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'delivered'`).run(new Date().toISOString(), r.id);
  res.json({ request: getRequest(r.id) });
});

// ---------- archive: managers/admins delete requests, restore archived items, or delete them permanently ----------
// A request can be archived while nobody is working on it (needs a team, open, cancelled or closed).
app.delete('/api/requests/:id', auth, requireBoss, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r) return bad(res, 'Request not found.', 404);
  if (!['needs_team', 'open', 'cancelled', 'closed'].includes(r.status))
    return bad(res, 'Someone is working on this request or it has been delivered. Withdraw it or delete its task first.', 409);
  db.transaction(() => {
    db.prepare('UPDATE requests SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL').run(new Date().toISOString(), u.id, r.id);
    db.prepare('INSERT INTO request_events (request_id, user_id, message) VALUES (?,?,?)').run(r.id, u.id, `${u.name} deleted the request`);
  })();
  res.json({ ok: true });
});
app.post('/api/requests/:id/restore', auth, requireBoss, (req, res) => {
  const u = req.user, r = getAnyRequest(Number(req.params.id));
  if (!r || !r.deleted_at) return bad(res, 'Only a deleted request can be restored.', 404);
  db.transaction(() => {
    db.prepare('UPDATE requests SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(r.id);
    db.prepare('INSERT INTO request_events (request_id, user_id, message) VALUES (?,?,?)').run(r.id, u.id, `Restored by ${u.name}`);
  })();
  res.json({ request: getRequest(r.id) });
});
app.delete('/api/requests/:id/permanent', auth, requireBoss, (req, res) => {
  const r = getAnyRequest(Number(req.params.id));
  if (!r || !r.deleted_at) return bad(res, 'Only a deleted request can be deleted permanently.', 404);
  const stored = db.prepare('SELECT stored_name FROM files WHERE request_id = ?').all(r.id);
  db.prepare('DELETE FROM requests WHERE id = ?').run(r.id); // its activity and attachments go with it; a linked task stays
  removeStoredFiles(stored);
  res.json({ ok: true });
});
// Restoring a task that came from a request puts it back on that request, if the request is still waiting for it
// (open again after a delete/give back, or cancelled by the requester withdrawing it from this person).
app.post('/api/tasks/:id/restore', auth, requireBoss, (req, res) => {
  const u = req.user, task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !task.deleted_at) return bad(res, 'Only a deleted task can be restored.', 404);
  const r = task.archived_request_id ? getAnyRequest(task.archived_request_id) : null;
  if (r && r.deleted_at) return bad(res, 'Restore the request this task came from first.', 409);
  const relink = !!r && !r.task_id && (r.status === 'open' || (r.status === 'cancelled' && r.withdrawn_from_id === task.assignee_id));
  if (r && !relink) return bad(res, 'The request this task came from has been taken by someone else or finished, so the task can’t be restored. Its record stays in History.', 409);
  db.transaction(() => {
    db.prepare('UPDATE tasks SET deleted_at = NULL, deleted_by = NULL, archived_request_id = NULL WHERE id = ?').run(task.id);
    if (!relink) return;
    // A request sent to a person (assigned by the requester to someone else) becomes a person request again.
    const asked = task.assigned_by === r.requested_by && task.assigned_by !== task.assignee_id ? task.assignee_id : null;
    db.prepare(`UPDATE requests SET status = 'assigned', task_id = ?, asked_person_id = ?, closed_at = NULL, withdrawn_from_id = NULL WHERE id = ?`)
      .run(task.id, asked, r.id);
    const who = db.prepare('SELECT name FROM users WHERE id = ?').get(task.assignee_id);
    db.prepare('INSERT INTO request_events (request_id, user_id, message) VALUES (?,?,?)').run(r.id, u.id, `Restored by ${u.name}: ${who ? who.name : 'the assignee'} has it again`);
  })();
  res.json({ ok: true, task_id: task.id, request_id: relink ? r.id : null });
});
app.delete('/api/tasks/:id/permanent', auth, requireBoss, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !task.deleted_at) return bad(res, 'Only a deleted task can be deleted permanently.', 404);
  const stored = db.prepare('SELECT stored_name FROM files WHERE task_id = ?').all(task.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id); // its updates and files go with it
  removeStoredFiles(stored);
  res.json({ ok: true });
});

// ---------- live updates (Server-Sent Events) ----------
// Each signed-in page (and the desktop app) keeps one GET /api/stream open. Events: message, deleted, read, conversation.
const streams = new Map(); // user id -> Set of open responses
function push(userIds, event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(typeof data === 'function' ? null : data)}\n\n`;
  for (const id of new Set(userIds)) for (const res of streams.get(id) || []) {
    try { res.write(typeof data === 'function' ? `event: ${event}\ndata: ${JSON.stringify(data(id))}\n\n` : line); } catch (e) { /* closed */ }
  }
}
app.get('/api/stream', auth, (req, res) => {
  const uid = req.user.id, token = req.cookies.sid;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n: connected\n\n');
  const set = streams.get(uid) || new Set(); streams.set(uid, set);
  set.add(res);
  if (set.size > 10) { const oldest = set.values().next().value; set.delete(oldest); oldest.end(); }
  // Ping every 25 s; also ends the stream once the session is gone (signed out, password changed, deactivated).
  const sessionOk = db.prepare(`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`);
  const ping = setInterval(() => { if (!sessionOk.get(token)) return res.end(); res.write(': ping\n\n'); }, 25000);
  const done = () => { clearInterval(ping); set.delete(res); if (!set.size && streams.get(uid) === set) streams.delete(uid); };
  res.on('close', done);
});

// ---------- chat ----------
// Only members of a conversation can read it, its files and its search hits — admins and managers included.
// Every endpoint about one conversation starts with chatMember(); no membership = 404.
const CHAT_PAGE = 50;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const chatMember = (u, convId) => db.prepare(`SELECT c.*, cm.last_read_message_id, cm.muted FROM conversations c
  JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? WHERE c.id = ?`).get(u.id, Number(convId));
const memberIds = convId => db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(convId).map(r => r.user_id);
const UNREAD = `(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cm.conversation_id AND m.id > cm.last_read_message_id
  AND m.deleted_at IS NULL AND (m.sender_id IS NULL OR m.sender_id != cm.user_id))`;
// Unread messages in the user's unmuted chats (the menu count and the desktop badge).
const chatUnreadTotal = uid => db.prepare(`SELECT COALESCE(SUM(${UNREAD}), 0) AS n FROM conversation_members cm WHERE cm.user_id = ? AND cm.muted = 0`).get(uid).n;
// A direct chat is named after the other person.
function chatName(c, uid) {
  if (c.type !== 'direct') return c.name || 'Group';
  const o = db.prepare(`SELECT us.name FROM conversation_members cm JOIN users us ON us.id = cm.user_id
    WHERE cm.conversation_id = ? AND cm.user_id != ?`).get(c.id, uid);
  return o ? o.name : 'Former member';
}
// Group creators and managers/admins (who are members) may rename a group and add/remove people.
const canManageChat = (u, c) => c.type === 'group' && !c.archived_at && (c.created_by === u.id || isBoss(u));
function messageViews(rows) {
  const files = rows.length ? db.prepare(`SELECT id, message_id, original_name AS name, size, mime FROM files
    WHERE message_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`).all(...rows.map(m => m.id)) : [];
  return rows.map(m => m.deleted_at
    ? { id: m.id, sender_id: m.sender_id, sender_name: m.sender_name, created_at: m.created_at, deleted: true, body: '', files: [] }
    : { id: m.id, sender_id: m.sender_id, sender_name: m.sender_name, created_at: m.created_at, deleted: false, body: m.body,
        files: files.filter(f => f.message_id === m.id).map(({ message_id, ...f }) => ({ ...f, is_image: IMAGE_MIME.includes(f.mime) })) });
}
const MSG_SELECT = `SELECT m.*, s.name AS sender_name FROM messages m LEFT JOIN users s ON s.id = m.sender_id`;
const ACTIVE_USER = id => db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(Number(id));
// Add people (their read marker starts at the latest message, so earlier history doesn't count as unread).
function addChatMembers(convId, ids) {
  const last = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE conversation_id = ?').get(convId).n;
  const ins = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, last_read_message_id) VALUES (?,?,?)');
  return ids.filter(id => ins.run(convId, id, last).changes);
}

// Team chats: one per team; members = the team's active members plus its lead. Called after every change to teams or people.
function syncTeamChats() {
  const changed = [];
  db.transaction(() => {
    for (const t of db.prepare('SELECT id, name, lead_id FROM teams').all()) {
      let c = db.prepare(`SELECT * FROM conversations WHERE type = 'team' AND team_id = ?`).get(t.id);
      if (!c) c = db.prepare(`INSERT INTO conversations (type, name, team_id) VALUES ('team', ?, ?) RETURNING *`).get(t.name, t.id);
      else if (c.name !== t.name) { db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(t.name, c.id); changed.push(...memberIds(c.id)); }
      const want = db.prepare('SELECT id FROM users WHERE active = 1 AND (team_id = ? OR id = ?)').all(t.id, t.lead_id || 0).map(r => r.id);
      const have = memberIds(c.id);
      const gone = have.filter(id => !want.includes(id));
      for (const id of gone) db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(c.id, id);
      changed.push(...gone, ...addChatMembers(c.id, want.filter(id => !have.includes(id))));
    }
  })();
  if (changed.length) push(changed, 'conversation', {});
}
syncTeamChats();

app.get('/api/chat', auth, (req, res) => {
  const u = req.user;
  const rows = db.prepare(`SELECT c.*, cm.muted, ${UNREAD} AS unread,
      (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count,
      lm.id AS last_id, lm.body AS last_body, lm.deleted_at AS last_deleted, lm.sender_id AS last_sender_id, ls.name AS last_sender_name,
      (SELECT original_name FROM files f WHERE f.message_id = lm.id ORDER BY f.id LIMIT 1) AS last_file
    FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
    LEFT JOIN messages lm ON lm.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id) LEFT JOIN users ls ON ls.id = lm.sender_id
    WHERE cm.user_id = ? ORDER BY c.archived_at IS NOT NULL, COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC`).all(u.id);
  const conversations = rows.map(c => ({
    id: c.id, type: c.type, name: chatName(c, u.id), muted: !!c.muted, archived: !!c.archived_at, unread: c.unread, member_count: c.member_count,
    last_message_at: c.last_message_at, can_manage: canManageChat(u, c),
    last: c.last_id ? { sender_name: c.last_sender_id === u.id ? 'You' : c.last_sender_name, deleted: !!c.last_deleted,
      text: c.last_deleted ? 'This message was deleted' : c.last_body ? c.last_body.slice(0, 120) : c.last_file ? '📎 ' + c.last_file : '' } : null
  }));
  res.json({ conversations, unread_total: chatUnreadTotal(u.id) });
});
// Everyone active (name and team only), for "New chat" / "New group".
app.get('/api/chat/people', auth, (req, res) => {
  res.json({ people: db.prepare(`SELECT us.id, us.name, us.role, tm.name AS team_name FROM users us LEFT JOIN teams tm ON tm.id = us.team_id
    WHERE us.active = 1 AND us.id != ? ORDER BY us.name`).all(req.user.id) });
});
app.post('/api/chat/direct', auth, (req, res) => {
  const u = req.user, other = ACTIVE_USER(req.body.user_id);
  if (!other || other.id === u.id) return bad(res, 'Choose another active person.');
  const id = db.transaction(() => {
    const c = db.prepare(`SELECT c.id FROM conversations c WHERE c.type = 'direct'
      AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?)
      AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?)`).get(u.id, other.id);
    if (c) return c.id;
    const n = db.prepare(`INSERT INTO conversations (type, created_by) VALUES ('direct', ?)`).run(u.id).lastInsertRowid;
    addChatMembers(n, [u.id, other.id]);
    return n;
  })();
  res.json({ conversation_id: id });
});
app.post('/api/chat/groups', auth, (req, res) => {
  const u = req.user, name = str(req.body.name, 100);
  if (!name) return bad(res, 'Enter a group name.');
  const ids = [...new Set((Array.isArray(req.body.user_ids) ? req.body.user_ids : []).map(Number))].filter(id => id !== u.id);
  if (!ids.length) return bad(res, 'Choose at least one person.');
  if (ids.some(id => !ACTIVE_USER(id))) return bad(res, 'Choose active people only.');
  const id = db.transaction(() => {
    const n = db.prepare(`INSERT INTO conversations (type, name, created_by) VALUES ('group', ?, ?)`).run(name, u.id).lastInsertRowid;
    addChatMembers(n, [u.id, ...ids]);
    return n;
  })();
  push(ids, 'conversation', { conversation_id: id });
  res.json({ conversation_id: id });
});
function managedChat(req, res) {
  const c = chatMember(req.user, req.params.id);
  if (!c) { bad(res, 'Conversation not found.', 404); return null; }
  if (!canManageChat(req.user, c)) { bad(res, c.type === 'group' ? 'Only the person who made this group or a manager can change it.' : 'Only groups can be changed.', 403); return null; }
  return c;
}
app.patch('/api/chat/:id', auth, (req, res) => {
  const c = managedChat(req, res); if (!c) return;
  const name = str(req.body.name, 100);
  if (!name) return bad(res, 'Enter a group name.');
  db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(name, c.id);
  push(memberIds(c.id), 'conversation', { conversation_id: c.id });
  res.json({ ok: true });
});
app.put('/api/chat/:id/members/:userId', auth, (req, res) => {
  const c = managedChat(req, res); if (!c) return;
  const p = ACTIVE_USER(req.params.userId);
  if (!p) return bad(res, 'Choose an active person.');
  addChatMembers(c.id, [p.id]);
  push(memberIds(c.id), 'conversation', { conversation_id: c.id });
  res.json({ ok: true });
});
app.delete('/api/chat/:id/members/:userId', auth, (req, res) => {
  const c = managedChat(req, res); if (!c) return;
  const uid = Number(req.params.userId);
  if (uid === req.user.id) return bad(res, 'Use "Leave" to leave the group.');
  const before = memberIds(c.id);
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(c.id, uid);
  push(before, 'conversation', { conversation_id: c.id });
  res.json({ ok: true });
});
app.post('/api/chat/:id/leave', auth, (req, res) => {
  const c = chatMember(req.user, req.params.id);
  if (!c) return bad(res, 'Conversation not found.', 404);
  if (c.type !== 'group') return bad(res, c.type === 'team' ? 'Team chats follow team membership.' : 'You can’t leave a direct chat.');
  const before = memberIds(c.id);
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(c.id, req.user.id);
  push(before, 'conversation', { conversation_id: c.id });
  res.json({ ok: true });
});
app.put('/api/chat/:id/mute', auth, (req, res) => {
  const c = chatMember(req.user, req.params.id);
  if (!c) return bad(res, 'Conversation not found.', 404);
  db.prepare('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?').run(req.body.muted ? 1 : 0, c.id, req.user.id);
  push([req.user.id], 'read', { conversation_id: c.id, unread_total: chatUnreadTotal(req.user.id) });
  res.json({ ok: true, muted: !!req.body.muted });
});
app.get('/api/chat/search', auth, (req, res) => {
  const u = req.user, q = str(req.query.q, 100);
  if (q.length < 2) return res.json({ results: [] });
  const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
  const rows = db.prepare(`${MSG_SELECT} JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.deleted_at IS NULL AND (m.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id AND f.original_name LIKE ? ESCAPE '\\'))
    ORDER BY m.id DESC LIMIT 50`).all(u.id, like, like);
  const names = {};
  res.json({ results: messageViews(rows).map((m, i) => {
    const cid = rows[i].conversation_id;
    if (!(cid in names)) names[cid] = chatName(db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid), u.id);
    return { conversation_id: cid, conversation_name: names[cid], message: m };
  }) });
});
app.get('/api/chat/:id', auth, (req, res) => {
  const u = req.user, c = chatMember(u, req.params.id);
  if (!c) return bad(res, 'Conversation not found.', 404);
  const members = db.prepare(`SELECT us.id, us.name, us.active, tm.name AS team_name FROM conversation_members cm JOIN users us ON us.id = cm.user_id
    LEFT JOIN teams tm ON tm.id = us.team_id WHERE cm.conversation_id = ? ORDER BY us.name`).all(c.id).map(m => ({ ...m, active: !!m.active }));
  const rows = db.prepare(`${MSG_SELECT} WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ?`).all(c.id, CHAT_PAGE).reverse();
  res.json({ conversation: { id: c.id, type: c.type, name: chatName(c, u.id), muted: !!c.muted, archived: !!c.archived_at, created_by: c.created_by,
    can_manage: canManageChat(u, c), last_read_message_id: c.last_read_message_id }, members, messages: messageViews(rows), more: rows.length === CHAT_PAGE });
});
// Older messages (before=<id>) or, for the polling fallback, newer ones (after=<id>).
app.get('/api/chat/:id/messages', auth, (req, res) => {
  const c = chatMember(req.user, req.params.id);
  if (!c) return bad(res, 'Conversation not found.', 404);
  if (req.query.after !== undefined) {
    const rows = db.prepare(`${MSG_SELECT} WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id LIMIT 200`).all(c.id, Number(req.query.after) || 0);
    const deleted = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND deleted_at IS NOT NULL').all(c.id).map(r => r.id);
    return res.json({ messages: messageViews(rows), deleted });
  }
  const rows = db.prepare(`${MSG_SELECT} WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
    .all(c.id, Number(req.query.before) || Number.MAX_SAFE_INTEGER, CHAT_PAGE).reverse();
  res.json({ messages: messageViews(rows), more: rows.length === CHAT_PAGE });
});
// Membership is checked before the upload is parsed.
function chatPostable(req, res, next) {
  const c = chatMember(req.user, req.params.id);
  if (!c) return bad(res, 'Conversation not found.', 404);
  if (c.archived_at) return bad(res, 'This chat is archived (the team was deleted). You can read it but not post.', 409);
  req.chat = c; next();
}
app.post('/api/chat/:id/messages', auth, chatPostable, withUploads, (req, res) => {
  const u = req.user, c = req.chat, body = typeof req.body.body === 'string' ? req.body.body.replace(/\r\n/g, '\n').trim() : '';
  if (body.length > 5000) return bad(res, 'A message can be up to 5000 characters.');
  if (!body && !(req.files || []).length) return bad(res, 'Write a message or attach a file.');
  const id = db.transaction(() => {
    const m = db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?,?,?)').run(c.id, u.id, body).lastInsertRowid;
    saveUploads(req, { message_id: m });
    db.prepare(`UPDATE conversations SET last_message_at = (SELECT created_at FROM messages WHERE id = ?) WHERE id = ?`).run(m, c.id);
    db.prepare('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?').run(m, c.id, u.id);
    return m;
  })();
  const message = messageViews([db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(id)])[0];
  const muted = new Set(db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND muted = 1').all(c.id).map(r => r.user_id));
  push(memberIds(c.id), 'message', uid => ({ conversation_id: c.id, conversation_name: chatName(c, uid), type: c.type, muted: muted.has(uid),
    unread_total: chatUnreadTotal(uid), message }));
  res.json({ message });
});
app.delete('/api/chat/messages/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id));
  if (!m || !chatMember(req.user, m.conversation_id)) return bad(res, 'Message not found.', 404);
  if (m.sender_id !== req.user.id) return bad(res, 'You can only delete your own messages.', 403);
  db.prepare(`UPDATE messages SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`).run(m.id); // files stay on disk
  push(memberIds(m.conversation_id), 'deleted', uid => ({ conversation_id: m.conversation_id, message_id: m.id, unread_total: chatUnreadTotal(uid) }));
  res.json({ ok: true });
});
app.post('/api/chat/:id/read', auth, (req, res) => {
  const u = req.user, c = chatMember(u, req.params.id);
  if (!c) return bad(res, 'Conversation not found.', 404);
  const upTo = Math.min(Number(req.body.message_id) || 0, db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE conversation_id = ?').get(c.id).n);
  db.prepare('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ? AND last_read_message_id < ?').run(upTo, c.id, u.id, upTo);
  const last = Math.max(upTo, c.last_read_message_id), unread_total = chatUnreadTotal(u.id);
  push([u.id], 'read', { conversation_id: c.id, last_read_message_id: last, unread_total });
  res.json({ last_read_message_id: last, unread_total });
});

// ---------- file download (sign-in + same visibility as the task or request) ----------
app.get('/api/files/:id', auth, (req, res) => {
  const u = req.user, f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
  let ok = false, inline = false;
  if (f && f.message_id) { // chat files: members of the conversation only, and only while the message isn't deleted
    const m = db.prepare('SELECT conversation_id, deleted_at FROM messages WHERE id = ?').get(f.message_id);
    ok = !!m && !m.deleted_at && !!chatMember(u, m.conversation_id);
    inline = ok && req.query.inline === '1' && IMAGE_MIME.includes(f.mime); // image thumbnails
  } else if (f && f.task_id) {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(f.task_id);
    ok = !!task && canSeeTask(u, task);
    if (!ok) { // files of a delivered request's task are visible to the people on that request
      const r = db.prepare(`${REQ_SELECT} WHERE r.task_id = ? AND r.status IN ('delivered','closed')`).get(f.task_id);
      ok = !!r && canSeeRequestFiles(u, r);
    }
  } else if (f && f.request_id) {
    const r = getRequest(f.request_id);
    ok = !!r && canSeeRequestFiles(u, r);
  }
  if (!ok || !/^[0-9a-f]{32}$/.test(f.stored_name)) return bad(res, 'File not found.', 404);
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.type(f.mime || 'application/octet-stream');
  if (inline) {
    res.set({ 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, max-age=86400' });
    return res.sendFile(path.join(UPLOAD_DIR, f.stored_name), err => { if (err && !res.headersSent) bad(res, 'File not found.', 404); });
  }
  res.download(path.join(UPLOAD_DIR, f.stored_name), f.original_name, err => {
    if (err && !res.headersSent) bad(res, 'File not found.', 404);
  });
});

// ---------- history ----------
// One row per document request (with its linked task) and one per task that isn't a request's task.
const LATEST_SUBMIT = `(SELECT MAX(created_at) FROM task_updates WHERE task_id = t.id AND message LIKE 'Submitted for approval%')`;
const LATEST_APPROVE = `(SELECT MAX(created_at) FROM task_updates WHERE task_id = t.id AND status = 'completed' AND (message LIKE 'Approved%' OR message LIKE 'Self-approved by %'))`;
const SELF_APPROVED = `EXISTS (SELECT 1 FROM task_updates WHERE task_id = t.id AND message LIKE 'Self-approved by %')`;
const SEND_BACKS = `(SELECT group_concat(substr(message, 12), ' | ') FROM task_updates WHERE task_id = t.id AND message LIKE 'Sent back: %')`;
function historyRows(u, q) {
  const s = taskScope(u, true); // History also lists archived (deleted) tasks and requests, with status deleted
  const taskRows = db.prepare(`SELECT 'task' AS type, t.id, t.title, t.status, a.team_id, tm.name AS team_name,
      t.assignee_id, a.name AS assignee_name, t.assigned_by, b.name AS assigned_by_name, NULL AS requested_by, NULL AS requested_by_name,
      t.created_at AS assigned_at, ${LATEST_SUBMIT} AS submitted_at, ${LATEST_APPROVE} AS approved_at, t.completed_at,
      ab.name AS approved_by_name, t.status = 'completed' AND ${SELF_APPROVED} AS self_approved, ${SEND_BACKS} AS send_back_reasons, t.created_at AS created_at, t.id AS task_id,
      t.deleted_at, td.name AS deleted_by_name
    FROM tasks t JOIN users a ON a.id = t.assignee_id JOIN users b ON b.id = t.assigned_by
    LEFT JOIN teams tm ON tm.id = a.team_id LEFT JOIN users ab ON ab.id = t.approved_by LEFT JOIN users td ON td.id = t.deleted_by
    WHERE ${s.sql} AND t.id NOT IN (SELECT task_id FROM requests WHERE task_id IS NOT NULL)`).all(...s.params);
  // Requests: the same people who can see them on the board (requestScope).
  const { sql: rsql, params: rparams } = requestScope(u, true);
  const reqRows = db.prepare(`SELECT 'request' AS type, r.id, r.title, r.status, r.target_team_id AS team_id, tm.name AS team_name,
      t.assignee_id, a.name AS assignee_name, t.assigned_by, b.name AS assigned_by_name, r.requested_by, rb.name AS requested_by_name,
      t.created_at AS assigned_at, ${LATEST_SUBMIT} AS submitted_at, ${LATEST_APPROVE} AS approved_at, r.closed_at AS completed_at,
      ab.name AS approved_by_name, t.status = 'completed' AND ${SELF_APPROVED} AS self_approved, ${SEND_BACKS} AS send_back_reasons, r.created_at AS created_at, r.task_id,
      r.deleted_at, rd.name AS deleted_by_name
    FROM requests r JOIN users rb ON rb.id = r.requested_by LEFT JOIN teams tm ON tm.id = r.target_team_id LEFT JOIN users rd ON rd.id = r.deleted_by
    LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users b ON b.id = t.assigned_by
    LEFT JOIN users ab ON ab.id = t.approved_by WHERE ${rsql}`).all(...rparams);
  let rows = taskRows.concat(reqRows);
  // A task approved directly (no "Approved" update) still has an approval date: when it was completed.
  for (const r of rows) if (!r.approved_at && r.type === 'task' && r.approved_by_name && r.completed_at) r.approved_at = r.completed_at;
  for (const r of rows) if (r.type === 'request' && r.status === 'needs_team') r.team_name = 'Not decided yet';
  for (const r of rows) if (r.self_approved && r.approved_by_name) r.approved_by_name += ' (self-approved)';
  for (const r of rows) if (r.deleted_at) r.status = 'deleted';
  const person = Number(q.person), team = Number(q.team);
  if (person) rows = rows.filter(r => [r.assignee_id, r.assigned_by, r.requested_by].includes(person));
  if (team) rows = rows.filter(r => r.team_id === team);
  if (q.status) rows = rows.filter(r => r.status === q.status);
  const day = d => String(d || '').slice(0, 10);
  if (DATE_RE.test(q.from || '')) rows = rows.filter(r => day(r.created_at) >= q.from);
  if (DATE_RE.test(q.to || '')) rows = rows.filter(r => day(r.created_at) <= q.to);
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
const STATUS_LABEL = { assigned: 'Not started', in_progress: 'In progress', submitted: 'Waiting for approval', completed: 'Completed',
  needs_team: 'Needs a team', open: 'Open', delivered: 'Delivered', closed: 'Closed', cancelled: 'Cancelled', deleted: 'Deleted' };
function localTime(d) { // "YYYY-MM-DD HH:MM" in the server's time zone (TZ), for the CSV
  if (!d) return '';
  const dt = new Date(/[TZ]/.test(d) ? d : d.replace(' ', 'T') + 'Z');
  if (isNaN(dt)) return d;
  const p = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop Excel treating text as a formula
  return /[",\r\n;]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
}
app.get('/api/history', auth, (req, res) => {
  const rows = historyRows(req.user, req.query);
  if (req.query.format !== 'csv') return res.json({ rows });
  const cols = [['Title', r => r.title], ['Type', r => r.type === 'request' ? 'Request' : 'Task'], ['Status', r => STATUS_LABEL[r.status] || r.status],
    ['Team', r => r.team_name], ['Assigned to', r => r.assignee_name], ['Assigned by', r => r.assigned_by_name], ['Requested by', r => r.requested_by_name],
    ['Assigned date', r => localTime(r.assigned_at)], ['Submitted date', r => localTime(r.submitted_at)], ['Approved date', r => localTime(r.approved_at)],
    ['Completed date', r => localTime(r.completed_at)], ['Approved by', r => r.approved_by_name], ['Send-back reasons', r => r.send_back_reasons],
    ['Deleted', r => r.deleted_at ? `Deleted by ${r.deleted_by_name || 'unknown'} on ${localTime(r.deleted_at)}` : '']];
  const lines = [cols.map(c => csvCell(c[0])).join(',')].concat(rows.map(r => cols.map(c => csvCell(c[1](r))).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`taskdesk-history-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

// ---------- desktop app summary ----------
// A request still open (nobody took it) 24 hours after it became open — posted, sent to a team or given back — is
// marked once with reminded_at; the desktop app then reminds the team's lead and managers/admins ("Still unassigned").
// Runs on every summary check (each desktop app checks every minute), so no timer is needed.
function remindStaleRequests() {
  db.prepare(`UPDATE requests SET reminded_at = ? WHERE status = 'open' AND deleted_at IS NULL AND reminded_at IS NULL
    AND MAX(created_at, COALESCE((SELECT MAX(e.created_at) FROM request_events e WHERE e.request_id = requests.id), '')) < datetime('now', '-24 hours')`)
    .run(new Date().toISOString());
}
// Open requests waiting for someone to assign them: for teams the user leads (managers/admins: all teams).
const LEAD_OPEN_REQUESTS = `SELECT r.id, r.title, r.needed_by, r.status, r.reminded_at, tm.name AS team_name, rb.name AS requested_by_name
  FROM requests r JOIN teams tm ON tm.id = r.target_team_id JOIN users rb ON rb.id = r.requested_by WHERE r.status = 'open' AND r.deleted_at IS NULL`;

// Open tasks assigned to the signed-in person: used for the desktop icon badge and new-task notifications.
app.get('/api/my-summary', auth, (req, res) => {
  const u = req.user;
  remindStaleRequests();
  const OVERDUE = `status != 'completed' AND deadline IS NOT NULL AND deadline < date('now','localtime')`;
  const counts = db.prepare(`SELECT COUNT(*) AS open, SUM(${OVERDUE}) AS overdue
    FROM tasks WHERE assignee_id = ? AND status != 'completed' AND deleted_at IS NULL`).get(u.id);
  // Own open tasks, with their status. A task that was sent back also carries the reason.
  // `asked_by`: the requester, when the task is a request sent to this person ("<requester> asked you").
  const tasks = db.prepare(`SELECT t.id, t.title, t.deadline, t.priority, t.status, b.name AS assigned_by_name,
      (SELECT rb.name FROM requests pr JOIN users rb ON rb.id = pr.requested_by WHERE pr.task_id = t.id AND pr.asked_person_id = t.assignee_id) AS asked_by,
      CASE WHEN t.status = 'in_progress' THEN (SELECT substr(message, 12) FROM task_updates
        WHERE task_id = t.id AND message LIKE 'Sent back: %' ORDER BY id DESC LIMIT 1) END AS sent_back_reason
    FROM tasks t JOIN users b ON b.id = t.assigned_by
    WHERE t.assignee_id = ? AND t.status != 'completed' AND t.deleted_at IS NULL ORDER BY t.id DESC LIMIT 100`).all(u.id);
  // Own tasks approved in the last 3 days (so the app can say "was approved").
  const recently_approved = db.prepare(`SELECT id, title FROM tasks WHERE assignee_id = ? AND status = 'completed' AND deleted_at IS NULL
    AND approved_by IS NOT NULL AND completed_at >= ? ORDER BY completed_at DESC LIMIT 50`)
    .all(u.id, new Date(Date.now() - 3 * 864e5).toISOString());
  // Tasks waiting for this person's approval.
  const rs = reviewScope(u);
  const approvals = db.prepare(`SELECT t.id, t.title, t.deadline, t.priority, t.submitted_at, a.name AS assignee_name
    FROM tasks t JOIN users a ON a.id = t.assignee_id WHERE ${rs.sql} AND t.assignee_id != ? ORDER BY t.submitted_at LIMIT 100`).all(...rs.params, u.id);
  // Open document requests for my team (or teams I lead), and my own requests that have been delivered.
  // `i_lead`: the user leads that team (the desktop app then says "assign it to someone").
  const team_requests = db.prepare(`SELECT r.id, r.title, tm.name AS team_name, tm.lead_id = ? AS i_lead FROM requests r JOIN teams tm ON tm.id = r.target_team_id
    WHERE r.status = 'open' AND r.deleted_at IS NULL AND r.requested_by != ? AND (r.target_team_id = ? OR tm.lead_id = ?) ORDER BY r.id DESC LIMIT 100`)
    .all(u.id, u.id, u.team_id || 0, u.id).map(r => ({ ...r, i_lead: !!r.i_lead }));
  // Open requests for teams the user leads (part of the badge), and the ones flagged "still unassigned" for the
  // team's lead and for managers/admins.
  const assign_requests = db.prepare(`${LEAD_OPEN_REQUESTS} AND tm.lead_id = ? ORDER BY r.id DESC LIMIT 100`).all(u.id)
    .map(r => ({ id: r.id, title: r.title, team_name: r.team_name }));
  const unassigned_reminders = db.prepare(`${LEAD_OPEN_REQUESTS} AND r.reminded_at IS NOT NULL ${isBoss(u) ? '' : 'AND tm.lead_id = ?'}
    ORDER BY r.id DESC LIMIT 100`).all(...(isBoss(u) ? [] : [u.id])).map(r => ({ id: r.id, title: r.title, team_name: r.team_name }));
  const ready_requests = db.prepare(`SELECT id, title FROM requests WHERE requested_by = ? AND status = 'delivered' AND deleted_at IS NULL ORDER BY id DESC LIMIT 100`).all(u.id);
  // Managers/admins: requests posted without a team, waiting for someone to choose one.
  const needs_team_requests = isBoss(u) ? db.prepare(`SELECT id, title FROM requests WHERE status = 'needs_team' AND deleted_at IS NULL AND requested_by != ?
    ORDER BY id DESC LIMIT 100`).all(u.id) : [];
  // Requests sent straight to a member of a team the user leads ("<requester> (<team>) asked <person>").
  const team_asks = db.prepare(`SELECT r.id, r.title, rb.name AS requested_by_name, rt.name AS requester_team_name, ap.name AS person_name
    FROM requests r JOIN teams tm ON tm.id = r.target_team_id JOIN users rb ON rb.id = r.requested_by LEFT JOIN teams rt ON rt.id = rb.team_id
    JOIN users ap ON ap.id = r.asked_person_id
    WHERE r.status = 'assigned' AND r.deleted_at IS NULL AND tm.lead_id = ? AND r.requested_by != ? AND r.asked_person_id != ? ORDER BY r.id DESC LIMIT 100`).all(u.id, u.id, u.id);
  // Requests withdrawn in the last 3 days from this person, or from a member of a team the user leads.
  const withdrawn = db.prepare(`SELECT r.id, r.title, rb.name AS requested_by_name FROM requests r JOIN users rb ON rb.id = r.requested_by
    LEFT JOIN teams tm ON tm.id = r.target_team_id
    WHERE r.status = 'cancelled' AND r.deleted_at IS NULL AND r.withdrawn_from_id IS NOT NULL AND r.closed_at >= ? AND r.requested_by != ?
      AND (r.withdrawn_from_id = ? OR tm.lead_id = ?) ORDER BY r.id DESC LIMIT 100`)
    .all(new Date(Date.now() - 3 * 864e5).toISOString(), u.id, u.id, u.id);
  res.json({ user: publicUser(u), open: counts.open || 0, overdue: counts.overdue || 0, tasks, recently_approved, approvals, team_requests,
    ready_requests, needs_team_requests, assign_requests, unassigned_reminders, team_asks, withdrawn, chat_unread: chatUnreadTotal(u.id) });
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

  // "Requests to assign": open requests for teams the user leads; managers/admins: all open ones and those without a team.
  const u = req.user;
  const to_assign = isBoss(u)
    ? db.prepare(`SELECT r.id, r.title, r.needed_by, r.status, tm.name AS team_name, rb.name AS requested_by_name
        FROM requests r LEFT JOIN teams tm ON tm.id = r.target_team_id JOIN users rb ON rb.id = r.requested_by
        WHERE r.deleted_at IS NULL AND (r.status = 'needs_team' OR (r.status = 'open' AND r.target_team_id IS NOT NULL))
        ORDER BY r.status = 'open', r.needed_by IS NULL, r.needed_by, r.id LIMIT 50`).all()
    : u.role === 'lead' ? db.prepare(`${LEAD_OPEN_REQUESTS} AND tm.lead_id = ? ORDER BY r.needed_by IS NULL, r.needed_by, r.id LIMIT 50`).all(u.id) : [];

  res.json({ totals, projects, people, due_soon, awaiting_me, to_assign });
});

app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.get('*', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => console.log(`TaskDesk running on http://localhost:${PORT}`));

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const db = require('./db');
const mailer = require('./mailer');

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
  for (const f of ['server.js', 'db.js', 'mailer.js', 'package.json']) add(path.join(__dirname, f));
  const pub = path.join(__dirname, 'public');
  for (const f of fs.readdirSync(pub).sort()) add(path.join(pub, f));
  return h.digest('hex').slice(0, 12);
})();
app.get('/api/version', (req, res) => { noCache(res); res.json({ build: BUILD_ID }); });
// Desktop app auto-update files (latest.yml, installers). Public, no sign-in; missing files are a plain 404.
app.use('/updates', express.static(path.join(__dirname, 'updates'), { fallthrough: false, index: false, maxAge: 0 }));
app.use('/updates', (err, req, res, next) => res.status(err.status || 404).type('text').send('Not found'));

// ---------- helpers ----------
// users.role has no CHECK in the database: ROLES is the only list of valid roles, checked on every write.
// "manager" is the company manager (every team); "team_manager" only manages the teams in team_managers.
const ROLES = ['admin', 'manager', 'team_manager', 'lead', 'employee'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUSES = ['assigned', 'in_progress', 'submitted', 'completed'];
const isBoss = u => u.role === 'admin' || u.role === 'manager';
const isTM = u => !!u && u.role === 'team_manager';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(res, msg, code = 400) { return res.status(code).json({ error: msg }); }
function str(v, max = 5000) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function optDate(v) { if (v === null || v === '' || v === undefined) return null; return DATE_RE.test(v) ? v : undefined; }
function publicUser(u) {
  if (!u) return u;
  const team = u.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(u.team_id) : null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, lead_id: u.lead_id, team_id: u.team_id || null,
    team_name: team ? team.name : null, active: !!u.active, removed: !!u.removed_at,
    managed_teams: isTM(u) ? managedTeams(u.id) : [], is_owner: isOwner(u), protected: isProtected(u) };
}
// Teams can have several leads (team_leads), all equal: every check is "any lead of the team". teams.lead_id is only
// kept equal to the first lead for compatibility (syncLegacyLead); users.lead_id is no longer used.
// Team managers (team_managers) have everything a lead has in the teams they manage, so the lead scopes below cover
// "teams I lead or manage" (the team_powers view, db.js).
const LED_TEAMS = '(SELECT team_id FROM team_powers WHERE user_id = ?)';
const MANAGED_TEAMS = '(SELECT team_id FROM team_managers WHERE user_id = ?)';
const TEAM_MANAGER_IDS = `(SELECT id FROM users WHERE role = 'team_manager')`;
const managesTeam = (u, teamId) => !!(teamId && u && db.prepare('SELECT 1 FROM team_managers WHERE team_id = ? AND user_id = ?').get(teamId, u.id || u));
// Lead powers in a team: a lead of it or a team manager of it.
const runsTeam = (u, teamId) => !!(teamId && u && db.prepare('SELECT 1 FROM team_powers WHERE team_id = ? AND user_id = ?').get(teamId, u.id || u));
// The team's team managers (active ones), first-added first.
const managersOf = teamId => teamId ? db.prepare(`SELECT us.id, us.name FROM team_managers x JOIN users us ON us.id = x.user_id
  WHERE x.team_id = ? AND us.active = 1 ORDER BY x.added_at, x.rowid`).all(teamId) : [];
const managedTeams = userId => db.prepare('SELECT tm.id, tm.name FROM team_managers x JOIN teams tm ON tm.id = x.team_id WHERE x.user_id = ? ORDER BY tm.name').all(userId);
// Work done by a team manager is approved by another team manager of that team or a manager/admin, never by its leads.
const isTMWork = assigneeId => !!db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'team_manager'`).get(assigneeId);
const LED_MEMBERS = `(SELECT m.id FROM users m WHERE m.team_id IN ${LED_TEAMS})`;
const LED_REQUEST_TASKS = `(SELECT r.task_id FROM requests r WHERE r.target_team_id IN ${LED_TEAMS} AND r.task_id IS NOT NULL)`;
const isLeadOf = (u, teamId) => !!(teamId && u && db.prepare('SELECT 1 FROM team_leads WHERE team_id = ? AND user_id = ?').get(teamId, u.id || u));
// The team's leads (active ones), first-added first.
const leadsOf = teamId => teamId ? db.prepare(`SELECT us.id, us.name FROM team_leads tl JOIN users us ON us.id = tl.user_id
  WHERE tl.team_id = ? AND us.active = 1 ORDER BY tl.added_at, tl.rowid`).all(teamId) : [];
function syncLegacyLead(teamId) {
  db.prepare(`UPDATE teams SET lead_id = (SELECT user_id FROM team_leads WHERE team_id = teams.id ORDER BY added_at, rowid LIMIT 1) WHERE id = ?`).run(teamId);
}
function isMemberOfLedTeam(u, other) { return !!(other && other.team_id && runsTeam(u, other.team_id)); }
function validTeamLead(id) {
  return !!db.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1 AND role IN ('lead','manager','admin')`).get(id);
}

// Which tasks a user may see, as a SQL fragment on alias t. Archived (deleted) tasks only with `archived` (History).
function taskScope(u, archived = false) {
  const live = archived ? '' : ' AND t.deleted_at IS NULL';
  if (isBoss(u)) return { sql: '1=1' + live, params: [] };
  if (u.role === 'lead' || isTM(u)) return {
    sql: `(t.assignee_id = ? OR t.assigned_by = ? OR t.assignee_id IN ${LED_MEMBERS} OR t.id IN ${LED_REQUEST_TASKS})${live}`,
    params: [u.id, u.id, u.id, u.id]
  };
  return { sql: 't.assignee_id = ?' + live, params: [u.id] };
}
function canSeeTask(u, task) {
  const s = taskScope(u);
  return !!db.prepare(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${s.sql}`).get(task.id, ...s.params);
}
// Edit/delete: managers/admins and the assigner — and, when the assigner is a lead of the assignee's team, any lead of
// that team (leads are equal). A self-claimed request task (assigned_by = assignee) can't be edited or deleted by the
// claimer (they use "Give back"); the leads of the request's team can instead.
// A request sent to a person ("Ask a person") is handled like a self-claimed one: the target team's leads (not the
// requester) edit and approve it, and the person can give it back.
function canEditTask(u, task) {
  if (isBoss(u)) return true;
  const r = linkedRequest(task.id);
  if (r && (task.assigned_by === task.assignee_id || isPersonTask(task, r))) return runsTeam(u, r.target_team_id);
  return task.assigned_by === u.id || (assignerLeads(task) && runsTeam(u, assigneeTeam(task)));
}
const assigneeTeam = task => (db.prepare('SELECT team_id FROM users WHERE id = ?').get(task.assignee_id) || {}).team_id || null;
// The task was assigned by a lead (or team manager) of the assignee's team (then every lead and team manager of that
// team may approve/edit it).
function assignerLeads(task) { return task.assigned_by !== task.assignee_id && runsTeam(task.assigned_by, assigneeTeam(task)); }
function isPersonTask(task, r) { return !!(r && r.asked_person_id && r.task_id === task.id && r.asked_person_id === task.assignee_id); }
function isClaimer(u, task) {
  if (task.assignee_id !== u.id) return false;
  const r = linkedRequest(task.id);
  return !!r && (task.assigned_by === u.id || isPersonTask(task, r));
}
const GIVE_BACK_HINT = 'You took this from a document request. Use “Give back” to return it to the team.';
// Approval step: the assignee submits; reviewers approve or send back. Nobody reviews their own work.
// Reviewers: managers/admins; the person in assigned_by (when that isn't the assignee) — and when that person is a lead
// of the assignee's team, any lead of that team; for a self-claimed document request (assigned_by = assignee) any lead
// of the request's target team other than the assignee. Nobody else.
function linkedRequest(taskId) {
  return db.prepare(`SELECT r.*, tm.name AS team_name FROM requests r LEFT JOIN teams tm ON tm.id = r.target_team_id WHERE r.task_id = ?`).get(taskId);
}
// A person request is approved by any lead of the person's team or a manager/admin, never by the requester.
function canReviewTask(u, task) {
  const r = linkedRequest(task.id), person = isPersonTask(task, r);
  if (person && r.requested_by === u.id && u.id !== task.assignee_id) return false;
  if (isBoss(u)) return true; // managers/admins: any submitted task, including their own (recorded as self-approved)
  if (u.id === task.assignee_id) return false; // team managers included: never their own work
  // A team manager's work: only the team's other team managers, never its leads.
  const may = teamId => isTMWork(task.assignee_id) ? managesTeam(u, teamId) : runsTeam(u, teamId);
  if (task.assigned_by !== task.assignee_id && !person) return task.assigned_by === u.id || (assignerLeads(task) && may(assigneeTeam(task)));
  return !!(r && may(r.target_team_id));
}
// A plain task someone assigned to themself: they complete it directly. A self-claimed request task still needs approval.
function ownPlainTask(task) { return task.assigned_by === task.assignee_id && !linkedRequest(task.id); }
// SQL fragment (alias t): submitted tasks the user may approve.
const PERSON_TASKS = '(SELECT pr.task_id FROM requests pr JOIN tasks pt ON pt.id = pr.task_id WHERE pr.asked_person_id = pt.assignee_id)';
const MY_PERSON_ASKS = '(SELECT pr.task_id FROM requests pr JOIN tasks pt ON pt.id = pr.task_id WHERE pr.asked_person_id = pt.assignee_id AND pr.requested_by = ? AND pt.assignee_id != pr.requested_by)';
// Assigned by a lead of the assignee's team, and the assignee's team is one this user leads (one param: the user).
const ASSIGNED_BY_CO_LEAD = `EXISTS (SELECT 1 FROM users am JOIN team_powers al ON al.team_id = am.team_id AND al.user_id = t.assigned_by
  WHERE am.id = t.assignee_id AND am.team_id IN ${LED_TEAMS})`;
// A team manager's work only for the team managers of that team (one param each: the user).
const TM_WORK_OK = `(t.assignee_id NOT IN ${TEAM_MANAGER_IDS} OR EXISTS (SELECT 1 FROM users mm WHERE mm.id = t.assignee_id AND mm.team_id IN ${MANAGED_TEAMS}))`;
const TM_REQUEST_WORK_OK = `(t.assignee_id NOT IN ${TEAM_MANAGER_IDS} OR t.id IN (SELECT r.task_id FROM requests r WHERE r.target_team_id IN ${MANAGED_TEAMS} AND r.task_id IS NOT NULL))`;
function reviewScope(u) {
  return isBoss(u) ? { sql: `t.status = 'submitted' AND t.deleted_at IS NULL AND t.id NOT IN ${MY_PERSON_ASKS}`, params: [u.id] }
    : { sql: `t.status = 'submitted' AND t.deleted_at IS NULL AND t.assignee_id != ? AND (((t.assigned_by = ? OR (${ASSIGNED_BY_CO_LEAD} AND ${TM_WORK_OK}))
          AND t.assigned_by != t.assignee_id AND t.id NOT IN ${PERSON_TASKS})
        OR ((t.assigned_by = t.assignee_id OR t.id IN ${PERSON_TASKS}) AND t.id IN ${LED_REQUEST_TASKS} AND t.id NOT IN ${MY_PERSON_ASKS} AND ${TM_REQUEST_WORK_OK}))`,
      params: [u.id, u.id, u.id, u.id, u.id, u.id, u.id] };
}
// Who can actually approve a task (same rules as canReviewTask): the assigner if they aren't the assignee (plus the
// other leads of the assignee's team when the assigner is one of them), otherwise for a self-claimed request every lead
// of the target team except the assignee; plus any active manager/admin who isn't the assignee (`any_manager`), and the
// assignee themself if they are a manager/admin (`self`).
// For a person request (`request.asked_person_id` = the assignee): the person's team leads and managers/admins, never the requester.
function approversFor(assigneeId, assignedBy, request) {
  const active = id => db.prepare('SELECT name FROM users WHERE id = ? AND active = 1').get(id);
  const person = !!(request && request.asked_person_id && request.asked_person_id === assigneeId);
  const requester = person ? request.requested_by : 0;
  const names = [];
  // The team's leads and team managers; for a team manager's own work only the other team managers.
  const tmWork = isTMWork(assigneeId);
  const teamPeople = teamId => tmWork ? managersOf(teamId) : leadsOf(teamId).concat(managersOf(teamId));
  if (assignedBy !== assigneeId && !person) {
    const a = active(assignedBy); if (a) names.push(a.name);
    const team = assigneeTeam({ assignee_id: assigneeId });
    if (runsTeam(assignedBy, team)) for (const l of teamPeople(team)) if (l.id !== assignedBy && l.id !== assigneeId) names.push(l.name);
  } else if (request) {
    for (const l of teamPeople(request.target_team_id)) if (l.id !== assigneeId && l.id !== requester) names.push(l.name);
  }
  const any_manager = !!db.prepare(`SELECT 1 FROM users WHERE active = 1 AND role IN ('admin','manager') AND id NOT IN (?, ?)`).get(assigneeId, requester);
  // A manager/admin assignee can always approve their own work, so the "nobody can approve" block never applies to them.
  const self = !!db.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1 AND role IN ('admin','manager')`).get(assigneeId);
  return { names, any_manager, self, nobody: !names.length && !any_manager && !self };
}
// `assigneeId`: who would do the work. A lead's own request task is approved by another lead of the team or a manager/admin.
function nobodyCanApprove(request, assigneeId) {
  if (isTMWork(assigneeId))
    return `Nobody can approve this yet: a team manager’s work is approved by another team manager of ${request && request.team_name || 'the team'} or a manager. Ask a manager to approve it or to add another team manager.`;
  if (request && isLeadOf(assigneeId, request.target_team_id))
    return `Nobody can approve this yet: work a lead of ${request.team_name} takes is approved by another lead of the team or a manager. Ask a manager to add another lead.`;
  return request && request.team_name ? `Nobody can approve this yet. Ask a manager to set a lead for ${request.team_name}.`
    : 'Nobody can approve this yet. Ask a manager to add another manager or team lead.';
}
function linkedRequestFull(taskId) { return db.prepare(`${REQ_SELECT} WHERE r.task_id = ?`).get(taskId); }

// When a task linked to a document request is completed, the request is delivered (and undone if the task is reopened).
function syncRequestWithTask(taskId, newStatus, oldStatus) {
  if (newStatus === 'completed' && oldStatus !== 'completed') {
    if (db.prepare(`UPDATE requests SET status = 'delivered', delivered_at = ? WHERE task_id = ? AND status = 'assigned'`).run(new Date().toISOString(), taskId).changes)
      emailRequestReady(taskId);
  } else if (newStatus !== 'completed' && oldStatus === 'completed') {
    db.prepare(`UPDATE requests SET status = 'assigned', delivered_at = NULL WHERE task_id = ? AND status = 'delivered'`).run(taskId);
  }
}
function canAssignTo(u, assignee) {
  if (!assignee || !assignee.active) return false;
  if (isBoss(u)) return true;
  if (u.role !== 'lead' && !isTM(u)) return false;
  if (assignee.id === u.id) return true;
  if (!isMemberOfLedTeam(u, assignee)) return false;
  // A team manager's work is approved by another team manager or a manager, so only they assign it (never a lead).
  return !isTM(assignee) || managesTeam(u, assignee.team_id);
}


// ---------- file uploads ----------
// Files are stored in data/uploads/ under random names; the original name is kept in the files table. Any file type is
// allowed (firmware, source code, archives, docs…). Size per file: MAX_UPLOAD_MB from .env (default 50).
// Nothing uploaded is ever run or rendered inside TaskDesk: downloads are always attachments, typed
// application/octet-stream unless the content really is an image or a PDF (sniffFile), with nosniff and a sandbox CSP.
const MAX_FILE_MB = (n => Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 2048) : 50)(Number(process.env.MAX_UPLOAD_MB));
// Types recognised by their first bytes (never by the name alone). Only these are shown inline (chat image previews).
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
function sniffBytes(b) {
  if (b.length >= 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.slice(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}
function sniffFile(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16); return sniffBytes(b.slice(0, fs.readSync(fd, b, 0, 16, 0))); }
  catch (e) { return 'application/octet-stream'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')) }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 5, fields: 20, fieldSize: 64 * 1024, parts: 30 }
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
    ins.run(name, f.filename, f.size, sniffFile(f.path),
      req.user.id, link.task_id || null, link.update_id || null, link.request_id || null, link.message_id || null);
  }
}
// Files for several copies of an assignment: each file is stored once (no owning task) and linked to an update on
// every copy in task_files. links: [{ task_id, update_id }].
function saveSharedUploads(req, links) {
  const ins = db.prepare('INSERT INTO files (original_name, stored_name, size, mime, uploaded_by) VALUES (?,?,?,?,?)');
  const link = db.prepare('INSERT INTO task_files (file_id, task_id, update_id) VALUES (?,?,?)');
  for (const f of req.files || []) {
    const id = ins.run(cleanFileName(f.originalname), f.filename, f.size, sniffFile(f.path), req.user.id).lastInsertRowid;
    for (const l of links) link.run(id, l.task_id, l.update_id);
  }
}
// A task's files: its own, plus shared assignment files linked to it.
const taskFiles = taskId => db.prepare(`SELECT id, original_name, size, update_id, uploaded_by, created_at FROM files WHERE task_id = ?
  UNION ALL SELECT f.id, f.original_name, f.size, tf.update_id, f.uploaded_by, f.created_at FROM task_files tf JOIN files f ON f.id = tf.file_id
  WHERE tf.task_id = ? ORDER BY id`).all(taskId, taskId);

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
function requireAdmin(req, res, next) { return req.user.role === 'admin' ? next() : bad(res, 'Only admins can do this.', 403); }

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
  res.json({ user: publicUser(user), upload_max_mb: MAX_FILE_MB });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user), upload_max_mb: MAX_FILE_MB }));

app.post('/api/me/password', auth, (req, res) => {
  const { current, next: nextPw } = req.body;
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return bad(res, 'Current password is incorrect.');
  if (typeof nextPw !== 'string' || nextPw.length < 8) return bad(res, 'New password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(nextPw, 10), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.cookies.sid);
  res.json({ ok: true });
});

// ---------- email: password links, settings, preferences ----------
// One-time "Set your password" links. Only the SHA-256 of the token is stored; the token travels after the # in the link,
// so it never shows up in server logs or Referer headers. A new link replaces the person's earlier unused ones.
const TOKEN_HOURS = { welcome: 48, reset: 1 };
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function issueToken(user, purpose, byId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.transaction(() => {
    db.prepare(`UPDATE password_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(user.id);
    db.prepare(`INSERT INTO password_tokens (user_id, token_hash, purpose, created_by, expires_at) VALUES (?,?,?,?,datetime('now', ?))`)
      .run(user.id, hashToken(token), purpose, byId || null, `+${TOKEN_HOURS[purpose]} hours`);
  })();
  return mailer.link(`set-password?token=${token}`);
}
// A token that can still be used (not used, not expired, person active and not removed), with its person.
function liveToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return db.prepare(`SELECT pt.id, pt.purpose, pt.user_id, u.name FROM password_tokens pt JOIN users u ON u.id = pt.user_id
    WHERE pt.token_hash = ? AND pt.used_at IS NULL AND pt.expires_at > datetime('now') AND u.active = 1 AND u.removed_at IS NULL`).get(hashToken(token));
}
function sendWelcome(user, by) {
  const url = issueToken(user, 'welcome', by && by.id);
  return mailer.queue(user.email, 'Welcome to TaskDesk', mailer.layout({
    heading: `Welcome to TaskDesk, ${user.name}`,
    lines: [`${by ? by.name : 'Your admin'} added you to TaskDesk, Hi-Focus's task and request tracker. Your sign-in email is ${user.email}.`,
      'Choose your password to get started. The link works once and expires in 48 hours.'],
    button: { label: 'Set your password', url },
    after: ['If the link has expired, ask your manager to resend it, or use "Forgot password?" on the sign-in page.']
  }));
}
// Simple in-memory counters: { key → {n, reset} }; true when over the limit.
const limits = new Map();
function overLimit(key, max, windowMs) {
  const now = Date.now(), rec = limits.get(key) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
  rec.n++; limits.set(key, rec);
  if (limits.size > 5000) for (const [k, v] of limits) if (now > v.reset) limits.delete(k);
  return rec.n > max;
}

// Forgot password: always the same answer, so it never reveals whether an account exists. At most 3 links per email and
// 10 requests per IP an hour; over the limit nothing is sent (same answer).
app.post('/api/password/forgot', (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const answer = () => res.json({ ok: true, message: 'If that email exists, we’ve sent a link to reset your password.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter a valid email.');
  const ipOver = overLimit('forgot-ip:' + req.ip, 10, 3600e3), emailOver = overLimit('forgot-email:' + email, 3, 3600e3);
  if (ipOver || emailOver) { console.log(`[email] forgot-password limit reached (${ipOver ? 'IP' : 'email'}); nothing sent`); return answer(); }
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1 AND removed_at IS NULL').get(email);
  if (user && mailer.enabled()) {
    mailer.queue(user.email, 'Reset your TaskDesk password', mailer.layout({
      heading: 'Reset your password',
      lines: [`Hi ${user.name}, someone asked to reset the password for your TaskDesk account.`,
        'The link works once and expires in 1 hour. Using it signs you out everywhere.'],
      button: { label: 'Choose a new password', url: issueToken(user, 'reset', null) },
      after: ['If you didn\'t ask for this, you can ignore this email; your password stays the same.']
    }));
  }
  answer();
});
const DEAD_LINK = 'This link has expired or was already used. Ask for a new one with "Forgot password?".';
app.get('/api/password/check', (req, res) => {
  if (overLimit('pwlink-ip:' + req.ip, 60, 15 * 60e3)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
  const t = liveToken(req.query.token);
  if (!t) return bad(res, DEAD_LINK, 410);
  res.json({ ok: true, purpose: t.purpose, name: t.name });
});
// Set the password with a link: single use; ends all of the person's sessions and cancels their other links.
app.post('/api/password/set', (req, res) => {
  if (overLimit('pwlink-ip:' + req.ip, 60, 15 * 60e3)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  const t = liveToken(req.body.token);
  if (!t) return bad(res, DEAD_LINK, 410);
  const ok = db.transaction(() => {
    if (!db.prepare(`UPDATE password_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`).run(t.id).changes) return false;
    db.prepare(`UPDATE password_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(t.user_id);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), t.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(t.user_id);
    return true;
  })();
  if (!ok) return bad(res, DEAD_LINK, 410);
  console.log(`[password] ${t.purpose} link used by user ${t.user_id}; sessions ended`);
  res.json({ ok: true });
});

// Email settings (admins): what is configured (never the password), the last error, and a test email to themself.
app.get('/api/email/status', auth, requireAdmin, (req, res) => res.json(mailer.status()));
app.post('/api/email/test', auth, requireAdmin, async (req, res) => {
  const error = await mailer.sendNow(req.user.email, 'TaskDesk test email', mailer.layout({
    heading: 'Email is working',
    lines: [`Hi ${req.user.name}, this is a test email from TaskDesk. If you can read it, TaskDesk can send email.`],
    button: { label: 'Open TaskDesk', url: mailer.link('') }
  }));
  res.json(error ? { ok: false, error, status: mailer.status() } : { ok: true, to: req.user.email, status: mailer.status() });
});

// Optional notification emails (all off by default). "Still unassigned" only for people who lead a team.
const EMAIL_PREFS = ['email_assigned', 'email_approval', 'email_ready', 'email_unassigned', 'email_notes'];
const leadsAnyTeam = u => !!db.prepare('SELECT 1 FROM team_powers WHERE user_id = ?').get(u.id); // leads and team managers
const prefsOf = u => ({ ...Object.fromEntries(EMAIL_PREFS.map(k => [k, !!u[k]])), can_unassigned: leadsAnyTeam(u), email_enabled: mailer.enabled() });
app.get('/api/me/email-prefs', auth, (req, res) => res.json(prefsOf(req.user)));
app.put('/api/me/email-prefs', auth, (req, res) => {
  const f = {};
  for (const k of EMAIL_PREFS) if (req.body[k] !== undefined) f[k] = req.body[k] ? 1 : 0;
  if (f.email_unassigned && !leadsAnyTeam(req.user)) return bad(res, '"Still unassigned" emails are for team leads and team managers.', 403);
  const keys = Object.keys(f);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => f[k]), req.user.id);
  res.json(prefsOf(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
});

// Notification emails: short, the title and names only (never files, descriptions or chat), a button to open the item.
// Only to active people who turned that email on, never to the person who did the action.
function notifyEmail(userId, pref, subject, heading, lines, label, hashPath, actorId) {
  if (!mailer.enabled() || !userId || userId === actorId) return;
  const p = db.prepare(`SELECT name, email FROM users WHERE id = ? AND active = 1 AND removed_at IS NULL AND ${pref} = 1`).get(userId);
  if (!p) return;
  mailer.queue(p.email, subject, mailer.layout({ heading, lines: [`Hi ${p.name},`, ...lines], button: { label, url: mailer.link(hashPath) },
    after: ['You get this because it is turned on under Email notifications on your Account page in TaskDesk.'] }));
}
function emailAssigned(taskId, actor) {
  const t = db.prepare(`SELECT t.id, t.title, t.deadline, t.assignee_id, b.name AS by_name FROM tasks t LEFT JOIN users b ON b.id = t.assigned_by WHERE t.id = ?`).get(taskId);
  if (!t) return;
  notifyEmail(t.assignee_id, 'email_assigned', `New task: ${t.title}`, 'A task was assigned to you',
    [`${actor ? actor.name : t.by_name} assigned you "${t.title}"${t.deadline ? `, due ${t.deadline}` : ''}.`], 'Open the task', `tasks/${t.id}`, actor && actor.id);
}
function emailApprovers(taskId, actor) {
  if (!mailer.enabled()) return;
  const t = db.prepare(`SELECT t.*, a.name AS assignee_name FROM tasks t JOIN users a ON a.id = t.assignee_id WHERE t.id = ?`).get(taskId);
  if (!t || t.status !== 'submitted') return;
  for (const u of db.prepare('SELECT * FROM users WHERE active = 1 AND removed_at IS NULL AND email_approval = 1 AND id != ?').all(t.assignee_id))
    if (canReviewTask(u, t)) notifyEmail(u.id, 'email_approval', `Waiting for your approval: ${t.title}`, 'A task is waiting for your approval',
      [`${t.assignee_name} submitted "${t.title}" for approval.`], 'Review the task', `tasks/${t.id}`, actor && actor.id);
}
// Someone added a note or files to a task: its assignee is told, or its assigner when the assignee posted.
// Only the first 100 characters of the note, never the files.
function emailNote(taskId, actor, message, fileCount) {
  const t = db.prepare('SELECT id, title, assignee_id, assigned_by FROM tasks WHERE id = ?').get(taskId);
  if (!t) return;
  const to = actor.id === t.assignee_id ? t.assigned_by : t.assignee_id;
  const files = fileCount ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : '';
  const short = message.length > 100 ? message.slice(0, 100) + '…' : message;
  notifyEmail(to, 'email_notes', message ? `New note on: ${t.title}` : `Files added to: ${t.title}`,
    message ? 'A note was added to your task' : 'Files were added to your task',
    message ? [`${actor.name} added a note to "${t.title}"${files ? ` with ${files}` : ''}:`, `“${short}”`] : [`${actor.name} sent ${files} to "${t.title}".`],
    'Open the task', `tasks/${t.id}`, actor.id);
}
function emailRequestReady(taskId, actor) {
  const r = db.prepare(`SELECT id, title, requested_by FROM requests WHERE task_id = ? AND status = 'delivered' AND deleted_at IS NULL`).get(taskId);
  if (r) notifyEmail(r.requested_by, 'email_ready', `Your request is ready: ${r.title}`, 'Your request is ready',
    [`"${r.title}" has been delivered. Open it to get the files and mark it as received.`], 'Open the request', `requests/${r.id}`, actor && actor.id);
}

// ---------- owner and protected accounts ----------
// The owner (OWNER_EMAIL in .env) must be an active admin; nobody else can change the owner's account in any way.
// Resolved once at startup: if OWNER_EMAIL matches no active admin, nobody is the owner and the normal admin rules
// apply, so nobody is ever locked out. Ownership moves only with scripts/transfer-owner.sh (no API or UI).
// Protected accounts (users.protected, and always the owner) can't be removed, deactivated or given a lower role.
const OWNER_MSG = 'This is the owner account. Only the owner can change it.';
const PROTECTED_MSG = 'This account is protected. Only the owner can turn off protection.';
const OWNER_SELF_MSG = 'You’re the owner, so your account can’t be removed, deactivated or given a lower role. Ownership moves only with scripts/transfer-owner.sh on the server.';
const ROLE_RANK = { employee: 1, lead: 2, team_manager: 3, manager: 4, admin: 5 };
// The person's account activity (who, what, when): protection changes, refused changes, owner transfers.
function logAccount(userId, actorId, action, detail) {
  db.prepare('INSERT INTO account_events (user_id, actor_id, action, detail) VALUES (?,?,?,?)').run(userId, actorId || null, action, detail || '');
}
const ownerId = (() => {
  const email = String(process.env.OWNER_EMAIL || '').trim();
  const o = email ? db.prepare(`SELECT id, name FROM users WHERE email = ? COLLATE NOCASE AND role = 'admin' AND active = 1 AND removed_at IS NULL`).get(email) : null;
  if (o) console.log(`[owner] ${o.name} (id ${o.id}) is the owner`);
  else console.warn(`[owner] WARNING: ${email ? `OWNER_EMAIL "${email}" doesn't match an active admin` : 'OWNER_EMAIL is not set'}; nobody is treated as owner (normal admin rules apply).`);
  // Record a change of owner (first setup, a transfer, or the owner no longer matching) on the people concerned.
  const prev = Number((db.prepare(`SELECT value FROM app_settings WHERE key = 'owner_user_id'`).get() || {}).value) || null;
  const now = o ? o.id : null;
  if (prev !== now) db.transaction(() => {
    const name = id => (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || `user #${id}`;
    const how = '(OWNER_EMAIL in server/.env)';
    const text = prev && now ? `Owner changed from ${name(prev)} to ${name(now)} ${how}` : now ? `Owner set to ${name(now)} ${how}` : `${name(prev)} is no longer the owner: OWNER_EMAIL matches no active admin`;
    for (const id of [prev, now]) if (id && db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) logAccount(id, null, 'owner_transfer', text);
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('owner_user_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(now === null ? '' : String(now));
    console.log(`[owner] ${text}`);
  })();
  return now;
})();
const isOwner = u => !!u && ownerId !== null && u.id === ownerId;
const isProtected = u => !!u && (!!u.protected || isOwner(u));
// Someone other than the owner tries to change the owner's account: refuse (403) and record it. Returns true if refused.
function ownerRefused(req, res, target, what) {
  if (!isOwner(target) || isOwner(req.user)) return false;
  logAccount(target.id, req.user.id, 'owner_refused', `${req.user.name} tried to ${what}`);
  bad(res, OWNER_MSG, 403);
  return true;
}
// Route guard placed before requireAdmin/requireBoss, so the owner refusal (and its record) comes first on every endpoint.
const ownerFirst = what => (req, res, next) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  return target && ownerRefused(req, res, target, typeof what === 'function' ? what(req) : what) ? undefined : next();
};
function protectedRefused(req, res, target, what) {
  logAccount(target.id, req.user.id, 'protected_refused', `${req.user.name} tried to ${what}`);
  bad(res, PROTECTED_MSG, 403);
  return true;
}

// ---------- users ----------
app.get('/api/users', auth, (req, res) => {
  const u = req.user;
  let rows;
  // Removed people are left out of every list and picker; managers/admins can ask for them (All people → "Removed").
  if (isBoss(u)) rows = db.prepare(`SELECT * FROM users ${req.query.removed === '1' ? '' : 'WHERE removed_at IS NULL'} ORDER BY active DESC, name`).all();
  // Team managers, for "Add member": active people without a team (never managers, team managers or admins).
  else if (isTM(u) && req.query.pool === 'no_team') rows = db.prepare(`SELECT * FROM users WHERE team_id IS NULL AND active = 1 AND removed_at IS NULL
    AND role IN ('lead','employee') ORDER BY name`).all();
  // Leads and team managers: themself and the people in their teams (team managers also see those teams' leads and managers).
  else if (u.role === 'lead' || isTM(u)) rows = db.prepare(`SELECT * FROM users WHERE removed_at IS NULL AND (id = ? OR id IN ${LED_MEMBERS}
    OR id IN (SELECT user_id FROM team_powers WHERE team_id IN ${MANAGED_TEAMS})) ORDER BY active DESC, name`).all(u.id, u.id, u.id);
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
  const managed = managedTeamIds(req.body.managed_team_ids, role, true);
  if (managed.error) return bad(res, managed.error);
  // Welcome email with a "Set your password" link (when email is set up), or a password typed by the manager as before.
  const welcome = req.body.send_welcome !== undefined ? !!req.body.send_welcome && !password : !password;
  if (welcome && !mailer.enabled()) return bad(res, 'Email isn’t set up, so enter a temporary password for this person.');
  if (!welcome && password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (lead_id && !db.prepare(`SELECT 1 FROM users WHERE id = ? AND role IN ('lead','manager','admin')`).get(lead_id)) return bad(res, 'Choose a valid team lead.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'A user with this email already exists.');
  const r = db.prepare('INSERT INTO users (name,email,password_hash,role,lead_id,team_id) VALUES (?,?,?,?,?,?)')
    .run(name, email, bcrypt.hashSync(welcome ? crypto.randomBytes(32).toString('hex') : password, 10), role, lead_id, team_id);
  const became_lead = autoLead(r.lastInsertRowid, req.user.id);
  if (managed.ids) setManagedTeams(r.lastInsertRowid, managed.ids, req.user.id);
  syncTeamChats();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  const welcome_sent = welcome && sendWelcome(user, req.user);
  res.json({ user: publicUser(user), became_lead, welcome_sent });
});

// The teams a team manager manages (`managed_team_ids`, set by managers/admins in the person form). Returns { ids } (the
// full new list), {} (leave as is) or { error }. A team manager needs at least one team when the role is first given.
function managedTeamIds(value, role, required) {
  if (role !== 'team_manager') return {};
  if (!Array.isArray(value)) return required ? { error: 'Choose at least one team this team manager manages.' } : {};
  const ids = [...new Set(value.map(Number).filter(Boolean))];
  if (!ids.length) return { error: 'Choose at least one team this team manager manages.' };
  if (ids.some(id => !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id))) return { error: 'Choose valid teams.' };
  return { ids };
}
function setManagedTeams(userId, ids, by) {
  db.transaction(() => {
    db.prepare(`DELETE FROM team_managers WHERE user_id = ? AND team_id NOT IN (${ids.map(() => '?').join(',') || 'NULL'})`).run(userId, ...ids);
    const add = db.prepare('INSERT OR IGNORE INTO team_managers (team_id, user_id, added_by) VALUES (?,?,?)');
    for (const id of ids) add.run(id, userId, by);
  })();
}

// Resend the welcome email: a new "Set your password" link (48 h); earlier links stop working. Same rule as editing the person.
app.post('/api/users/:id/welcome', auth, ownerFirst('resend the welcome email (a new password link)'), requireBoss, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return bad(res, 'User not found.', 404);
  if (ownerRefused(req, res, target, 'resend the welcome email (a new password link)')) return;
  if (target.removed_at) return bad(res, 'This person was removed. An admin can restore them first.', 409);
  if (target.role === 'admin' && req.user.role !== 'admin') return bad(res, 'Only an admin can change an admin account.', 403);
  if (!target.active) return bad(res, 'This account is deactivated. Activate it first.', 409);
  if (!mailer.enabled()) return bad(res, 'Email isn’t set up. Set a password for this person instead.', 409);
  sendWelcome(target, req.user);
  res.json({ ok: true, email: target.email });
});

// Field names for refusal records.
const PERSON_FIELDS = { name: 'name', email: 'email', role: 'role', team_id: 'team', lead_id: 'lead', managed_team_ids: 'managed teams',
  active: 'active status', password: 'password', protected: 'protection' };
const patchWhat = req => 'change ' + (Object.keys(PERSON_FIELDS).filter(k => req.body[k] !== undefined && (k !== 'password' || req.body[k])).map(k => PERSON_FIELDS[k]).join(', ') || 'the account');
app.patch('/api/users/:id', auth, ownerFirst(patchWhat), requireBoss, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return bad(res, 'User not found.', 404);
  if (target.removed_at) return bad(res, 'This person was removed. An admin can restore them first.', 409);
  if (target.role === 'admin' && req.user.role !== 'admin') return bad(res, 'Only an admin can change an admin account.', 403);
  // The owner on their own account: name, team and lead (and password) only. The email stays equal to OWNER_EMAIL.
  if (isOwner(target)) {
    if ((req.body.role !== undefined && req.body.role !== target.role) || (req.body.active !== undefined && !req.body.active)) return bad(res, OWNER_SELF_MSG, 403);
    if (req.body.email !== undefined && str(req.body.email, 200).toLowerCase() !== target.email.toLowerCase())
      return bad(res, 'The owner’s email is set by OWNER_EMAIL in server/.env, so it can’t be changed here. Change both on the server (see scripts/restore.md).', 403);
    if (req.body.protected !== undefined && !req.body.protected) return bad(res, 'The owner account is always protected.', 403);
  }
  // Protected: never deactivated or given a lower role, by anyone.
  if (isProtected(target) && !isOwner(target)) {
    if (req.body.active !== undefined && !req.body.active && target.active) return protectedRefused(req, res, target, 'deactivate the account');
    if (req.body.role !== undefined && ROLES.includes(req.body.role) && ROLE_RANK[req.body.role] < ROLE_RANK[target.role])
      return protectedRefused(req, res, target, `lower the role to ${req.body.role}`);
  }
  // Protection on/off: only the owner.
  const protChange = req.body.protected !== undefined && !isOwner(target) && !!req.body.protected !== !!target.protected;
  if (protChange && !isOwner(req.user)) {
    logAccount(target.id, req.user.id, 'protected_refused', `${req.user.name} tried to turn protection ${req.body.protected ? 'on' : 'off'}`);
    return bad(res, 'Only the owner can turn protection on or off.', 403);
  }
  const f = {};
  if (protChange) f.protected = req.body.protected ? 1 : 0;
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
  const newRole = f.role || target.role;
  const managed = managedTeamIds(req.body.managed_team_ids, newRole, newRole === 'team_manager' && target.role !== 'team_manager');
  if (managed.error) return bad(res, managed.error);
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
  if (f.protected !== undefined) logAccount(target.id, req.user.id, f.protected ? 'protection_on' : 'protection_off', `${req.user.name} turned protection ${f.protected ? 'on' : 'off'}`);
  if (f.active === 0 || f.password_hash) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  // Can no longer lead a team (a team manager already has a lead's powers in the teams they manage).
  if (f.role === 'employee' || f.role === 'team_manager' || f.active === 0) {
    const led = db.prepare('SELECT team_id FROM team_leads WHERE user_id = ?').all(target.id);
    db.prepare('DELETE FROM team_leads WHERE user_id = ?').run(target.id);
    for (const l of led) syncLegacyLead(l.team_id);
  }
  // Manages teams only while the role is team_manager and the account is active.
  if ((f.role && f.role !== 'team_manager') || f.active === 0) db.prepare('DELETE FROM team_managers WHERE user_id = ?').run(target.id);
  else if (managed.ids) setManagedTeams(target.id, managed.ids, req.user.id);
  // Only when the team changed or the role became lead: a lead a manager removed on the team page stays removed.
  const became_lead = (f.team_id !== undefined && f.team_id !== target.team_id) || (f.role === 'lead' && target.role !== 'lead') ? autoLead(target.id, req.user.id) : null;
  syncTeamChats(); // team chats follow team membership, leads and deactivation
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)), became_lead });
});

// A person's account activity: managers/admins and the person themself. Newest first, last 100.
app.get('/api/users/:id/events', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!isBoss(req.user) && req.user.id !== id) return bad(res, 'Not allowed.', 403);
  res.json({ events: db.prepare(`SELECT e.id, e.action, e.detail, e.created_at, a.name AS actor_name FROM account_events e
    LEFT JOIN users a ON a.id = e.actor_id WHERE e.user_id = ? ORDER BY e.id DESC LIMIT 100`).all(id) });
});

// ---------- remove person (admins only) ----------
// Everything that ties a person to history. Logins, chat memberships and lead roles are not history: they just go.
const PERSON_RECORDS = [
  ['tasks', ['task assigned to them', 'tasks assigned to them'], 'SELECT COUNT(*) n FROM tasks WHERE assignee_id = @id'],
  ['assigned', ['task they assigned', 'tasks they assigned'], 'SELECT COUNT(*) n FROM tasks WHERE assigned_by = @id AND assignee_id != assigned_by'],
  ['approvals', ['task they approved', 'tasks they approved'], 'SELECT COUNT(*) n FROM tasks WHERE approved_by = @id'],
  ['requests', ['document request they made', 'document requests they made'], 'SELECT COUNT(*) n FROM requests WHERE requested_by = @id'],
  ['updates', ['task update or request activity', 'task updates and request activity'], 'SELECT (SELECT COUNT(*) FROM task_updates WHERE user_id = @id) + (SELECT COUNT(*) FROM request_events WHERE user_id = @id) n'],
  ['files', ['file they uploaded', 'files they uploaded'], 'SELECT COUNT(*) n FROM files WHERE uploaded_by = @id'],
  ['messages', ['chat message', 'chat messages'], 'SELECT COUNT(*) n FROM messages WHERE sender_id = @id'],
  ['other', ['other record (deleted items, asked/withdrawn requests, projects, chats or team links they made)', 'other records (deleted items, asked/withdrawn requests, projects, chats or team links they made)'], `SELECT
      (SELECT COUNT(*) FROM tasks WHERE deleted_by = @id) + (SELECT COUNT(*) FROM requests WHERE deleted_by = @id OR asked_person_id = @id OR withdrawn_from_id = @id)
      + (SELECT COUNT(*) FROM projects WHERE created_by = @id) + (SELECT COUNT(*) FROM conversations WHERE created_by = @id)
      + (SELECT COUNT(*) FROM team_connections WHERE created_by = @id) + (SELECT COUNT(*) FROM team_leads WHERE added_by = @id)
      + (SELECT COUNT(*) FROM team_managers WHERE added_by = @id) n`]
];
function personRecords(id) {
  const counts = {};
  for (const [key, [one, many], q] of PERSON_RECORDS) { const n = db.prepare(q).get({ id }).n; counts[key] = { label: n === 1 ? one : many, n }; }
  const total = Object.values(counts).reduce((a, c) => a + c.n, 0);
  const leads = db.prepare('SELECT tm.id, tm.name FROM team_leads tl JOIN teams tm ON tm.id = tl.team_id WHERE tl.user_id = ? ORDER BY tm.name').all(id);
  return { counts, total, leads };
}
function removalTarget(req, res) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) { bad(res, 'User not found.', 404); return null; }
  if (isOwner(target) && isOwner(req.user)) { bad(res, OWNER_SELF_MSG, 403); return null; }
  if (ownerRefused(req, res, target, 'remove the account')) return null;
  if (target.id === req.user.id) { bad(res, 'You can’t remove your own account.', 403); return null; }
  if (isProtected(target) && !target.removed_at) { protectedRefused(req, res, target, 'remove the account'); return null; }
  return target;
}
// What removing this person would do (for the confirmation dialog).
app.get('/api/users/:id/removal', auth, ownerFirst('remove the account'), requireAdmin, (req, res) => {
  const t = removalTarget(req, res); if (!t) return;
  if (t.removed_at) return bad(res, 'This person has already been removed.', 409);
  const r = personRecords(t.id);
  res.json({ user: publicUser(t), ...r, mode: r.total ? 'keep' : 'delete' });
});
// Remove: no records → the row is deleted; otherwise it is kept for History, marked removed, signed out, taken out of
// teams/leads/group and team chats, and its email is freed for a new account.
app.delete('/api/users/:id', auth, ownerFirst('remove the account'), requireAdmin, (req, res) => {
  const t = removalTarget(req, res); if (!t) return;
  if (t.removed_at) return bad(res, 'This person has already been removed.', 409);
  const r = personRecords(t.id);
  const led = r.leads.map(l => l.id);
  db.transaction(() => {
    if (!r.total) {
      db.prepare('UPDATE users SET lead_id = NULL WHERE lead_id = ?').run(t.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(t.id); // sessions, chat memberships (and mutes), lead roles go with it
    } else {
      const name = /\(removed\)$/.test(t.name) ? t.name : `${t.name} (removed)`; // shown like this wherever the name appears
      db.prepare(`UPDATE users SET active = 0, team_id = NULL, removed_at = datetime('now'), removed_by = ?, original_email = email,
        email = ?, name = ? WHERE id = ?`).run(req.user.id, `removed-${t.id}@removed.local`, name, t.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(t.id);
      db.prepare('DELETE FROM team_leads WHERE user_id = ?').run(t.id);
      db.prepare('DELETE FROM team_managers WHERE user_id = ?').run(t.id);
      db.prepare(`DELETE FROM conversation_members WHERE user_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE type IN ('group','team'))`).run(t.id);
    }
    for (const id of led) syncLegacyLead(id);
  })();
  syncTeamChats();
  res.json({ ok: true, mode: r.total ? 'kept' : 'deleted' });
});
// Restore a removed person: their original email must still be free. Teams and lead roles are not given back.
app.post('/api/users/:id/restore', auth, ownerFirst('restore the account'), requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!t || !t.removed_at) return bad(res, 'This person isn’t removed.', 404);
  if (ownerRefused(req, res, t, 'restore the account')) return;
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(t.original_email, t.id))
    return bad(res, `${t.original_email} is now used by another account, so ${t.name.replace(/ \(removed\)$/, '')} can’t be restored.`, 409);
  db.prepare(`UPDATE users SET active = 1, email = original_email, original_email = NULL, removed_at = NULL, removed_by = NULL,
    name = ? WHERE id = ?`).run(t.name.replace(/ \(removed\)$/, ''), t.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(t.id)) });
});

// ---------- projects ----------
// Projects: everyone sees every project; the counts only include tasks the user can see. With a team tab (`team=<id>`)
// only that team's projects, counted over that team's tasks; `team=none`: projects without a team.
const projectTeams = id => db.prepare('SELECT tm.id, tm.name FROM project_teams pt JOIN teams tm ON tm.id = pt.team_id WHERE pt.project_id = ? ORDER BY tm.name').all(id);
app.get('/api/projects', auth, (req, res) => {
  const s = taskScope(req.user), team = req.query.team;
  const byTeam = /^\d+$/.test(String(team || '')) ? Number(team) : null;
  const inTeam = byTeam ? ' AND t.assignee_id IN (SELECT id FROM users WHERE team_id = ?)' : '';
  const where = byTeam ? 'WHERE p.id IN (SELECT project_id FROM project_teams WHERE team_id = ?)'
    : team === 'none' ? 'WHERE p.id NOT IN (SELECT project_id FROM project_teams)' : '';
  const tp = byTeam ? [byTeam] : [];
  const rows = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${s.sql}${inTeam}) AS total,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed' AND ${s.sql}${inTeam}) AS completed
    FROM projects p ${where} ORDER BY p.status = 'closed', p.name`).all(...s.params, ...tp, ...s.params, ...tp, ...tp);
  res.json({ projects: rows.map(p => ({ ...p, teams: projectTeams(p.id) })) });
});
// Per team: its projects and their combined progress over that team's visible tasks (as the team tab counts them);
// "none": projects without a team; "all": every project over all visible tasks.
app.get('/api/projects/summary', auth, (req, res) => {
  const s = taskScope(req.user);
  const sum = (projectWhere, taskExtra, params) => db.prepare(`SELECT
      (SELECT COUNT(*) FROM projects p WHERE ${projectWhere}) AS projects,
      (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${projectWhere} AND ${s.sql}${taskExtra}) AS total,
      (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${projectWhere} AND t.status = 'completed' AND ${s.sql}${taskExtra}) AS completed`)
    .get(...params.p, ...params.p, ...s.params, ...params.t, ...params.p, ...s.params, ...params.t);
  const teams = {};
  for (const t of db.prepare('SELECT id FROM teams').all())
    teams[t.id] = sum('p.id IN (SELECT project_id FROM project_teams WHERE team_id = ?)', ' AND t.assignee_id IN (SELECT id FROM users WHERE team_id = ?)', { p: [t.id], t: [t.id] });
  teams.none = sum('p.id NOT IN (SELECT project_id FROM project_teams)', '', { p: [], t: [] });
  res.json({ teams, all: sum('1=1', '', { p: [], t: [] }) });
});
// Managers/admins: replace a project's teams. Returns an error text or null.
function setProjectTeams(projectId, teamIds) {
  if (!Array.isArray(teamIds)) return null;
  const ids = [...new Set(teamIds.map(Number))];
  if (ids.some(id => !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id))) return 'Choose valid teams.';
  db.transaction(() => {
    db.prepare('DELETE FROM project_teams WHERE project_id = ?').run(projectId);
    for (const id of ids) db.prepare('INSERT INTO project_teams (project_id, team_id) VALUES (?,?)').run(projectId, id);
  })();
  return null;
}

app.post('/api/projects', auth, requireBoss, (req, res) => {
  const name = str(req.body.name, 160);
  if (!name) return bad(res, 'Enter a project name.');
  if (Array.isArray(req.body.team_ids) && req.body.team_ids.some(id => !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(Number(id)))) return bad(res, 'Choose valid teams.');
  const r = db.prepare('INSERT INTO projects (name, description, created_by) VALUES (?,?,?)').run(name, str(req.body.description), req.user.id);
  setProjectTeams(r.lastInsertRowid, req.body.team_ids);
  res.json({ project: { ...db.prepare('SELECT * FROM projects WHERE id = ?').get(r.lastInsertRowid), teams: projectTeams(r.lastInsertRowid) } });
});

app.patch('/api/projects/:id', auth, requireBoss, (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
  if (!p) return bad(res, 'Project not found.', 404);
  const name = req.body.name !== undefined ? str(req.body.name, 160) : p.name;
  const description = req.body.description !== undefined ? str(req.body.description) : p.description;
  const status = req.body.status !== undefined ? req.body.status : p.status;
  if (!name) return bad(res, 'Project name cannot be empty.');
  if (!['active', 'on_hold', 'closed'].includes(status)) return bad(res, 'Choose a valid status.');
  const err = Array.isArray(req.body.team_ids) && req.body.team_ids.some(id => !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(Number(id))) ? 'Choose valid teams.' : null;
  if (err) return bad(res, err);
  db.transaction(() => {
    db.prepare('UPDATE projects SET name = ?, description = ?, status = ? WHERE id = ?').run(name, description, status, p.id);
    setProjectTeams(p.id, req.body.team_ids);
  })();
  res.json({ project: { ...db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id), teams: projectTeams(p.id) } });
});

// Team tabs: `team=<id>` → column = id, `team=none` → column IS NULL, anything else (all, missing) → no filter.
// These filters only ever narrow a list inside the user's existing scope.
function teamFilter(value, column, where, params) {
  if (value === 'none') where.push(`${column} IS NULL`);
  else if (/^\d+$/.test(String(value || ''))) { where.push(`${column} = ?`); params.push(Number(value)); }
}
// Search text for LIKE (with % and _ taken literally).
const likeText = q => '%' + String(q).replace(/[\\%_]/g, c => '\\' + c) + '%';

// ---------- tasks ----------
const TASK_SELECT = `SELECT t.*, a.name AS assignee_name, a.team_id, tm.name AS team_name, b.name AS assigned_by_name, p.name AS project_name,
  CASE WHEN t.status != 'completed' AND t.deadline IS NOT NULL AND t.deadline < date('now','localtime') THEN 1 ELSE 0 END AS overdue
  FROM tasks t JOIN users a ON a.id = t.assignee_id JOIN users b ON b.id = t.assigned_by LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN teams tm ON tm.id = a.team_id`;

// ---------- team blocks: per-team counts for the landing grids (Tasks, Requests, Projects) ----------
// Same scopes as the lists, so a card never counts anything its list wouldn't show. Keys: team id, "none", and "all"
// (everything the user can see, which can be more than the sum of the team cards).
const teamKey = id => id === null || id === undefined ? 'none' : String(id);
const WEEK_DONE = `t.status = 'completed' AND date(t.completed_at) >= date('now','localtime','-6 days')`; // as the dashboard
app.get('/api/tasks/summary', auth, (req, res) => {
  const s = taskScope(req.user);
  const cols = `COUNT(*) AS total, COALESCE(SUM(t.status != 'completed'), 0) AS open,
    COALESCE(SUM(t.status != 'completed' AND t.deadline IS NOT NULL AND t.deadline < date('now','localtime')), 0) AS overdue,
    COALESCE(SUM(t.status = 'submitted'), 0) AS submitted, COALESCE(SUM(${WEEK_DONE}), 0) AS done_week`;
  const from = `FROM tasks t JOIN users a ON a.id = t.assignee_id WHERE ${s.sql}`;
  const teams = {};
  for (const r of db.prepare(`SELECT a.team_id, ${cols} ${from} GROUP BY a.team_id`).all(...s.params)) { const { team_id, ...c } = r; teams[teamKey(team_id)] = c; }
  res.json({ teams, all: db.prepare(`SELECT ${cols} ${from}`).get(...s.params) });
});
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
  // Team tabs, search, quick filters and sort (all optional; they only narrow the list above).
  teamFilter(req.query.team, 'a.team_id', where, params);
  const q = str(req.query.q, 100);
  if (q) { where.push(`(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')`); params.push(likeText(q), likeText(q)); }
  if (req.query.due === 'overdue') where.push(`t.status != 'completed' AND t.deadline IS NOT NULL AND t.deadline < date('now','localtime')`);
  else if (req.query.due === 'week') where.push(`t.status != 'completed' AND t.deadline BETWEEN date('now','localtime') AND date('now','localtime','+6 days')`);
  if (req.query.priority === 'high') where.push(`t.priority IN ('urgent','high')`);
  else if (PRIORITIES.includes(req.query.priority)) { where.push('t.priority = ?'); params.push(req.query.priority); }
  if (req.query.review === 'mine') { const rs = reviewScope(req.user); where.push(`(${rs.sql})`); params.push(...rs.params); }
  const PRIO = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;
  const order = req.query.sort === 'priority' ? `t.status = 'completed', ${PRIO}, t.deadline IS NULL, t.deadline, t.id DESC`
    : req.query.sort === 'newest' ? 't.id DESC'
    : `t.status = 'completed', t.deadline IS NULL, t.deadline, ${PRIO}, t.id DESC`; // "deadline" (the default)
  const rows = db.prepare(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 1000`).all(...params);
  res.json({ tasks: rows });
});

// Create tasks: one separate task per person in assignee_ids (or the single assignee_id, kept for compatibility).
// Every person is checked with canAssignTo first; if anyone isn't allowed, nothing is created.
// Two or more people: the copies share an assignment_group_id. Attached files (multipart) go on each copy's first
// update; for a group they are stored once and linked to every copy.
function canCreateTask(req, res, next) {
  if (req.user.role === 'employee') return bad(res, 'Only managers and team leads can assign tasks.', 403);
  next();
}
app.post('/api/tasks', auth, canCreateTask, withUploads, (req, res) => {
  const u = req.user;
  const title = str(req.body.title, 200);
  let rawIds = req.body.assignee_ids;
  if (typeof rawIds === 'string') { try { rawIds = JSON.parse(rawIds); } catch (e) { rawIds = []; } } // multipart sends it as JSON text
  if (!Array.isArray(rawIds)) rawIds = req.body.assignee_id ? [req.body.assignee_id] : [];
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
  const created = db.transaction(() => {
    const links = people.map(({ user: a }) => {
      const id = db.prepare(`INSERT INTO tasks (title, description, project_id, assignee_id, assigned_by, priority, start_date, deadline)
        VALUES (?,?,?,?,?,?,?,?)`).run(title, description, project_id, a.id, u.id, priority, start_date, deadline).lastInsertRowid;
      const up = db.prepare('INSERT INTO task_updates (task_id,user_id,message,status) VALUES (?,?,?,?)').run(id, u.id, `Assigned to ${a.name}`, 'assigned');
      return { task_id: id, update_id: up.lastInsertRowid };
    });
    if (links.length > 1) {
      db.prepare(`UPDATE tasks SET assignment_group_id = ? WHERE id IN (${links.map(() => '?').join(',')})`).run(links[0].task_id, ...links.map(l => l.task_id));
      saveSharedUploads(req, links);
    } else saveUploads(req, links[0]);
    return links.map(l => l.task_id);
  })();
  const tasks = created.map(id => db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id));
  for (const id of created) emailAssigned(id, u);
  res.json({ task: tasks[0], tasks, count: tasks.length });
});

app.get('/api/tasks/:id', auth, (req, res) => {
  const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(Number(req.params.id));
  if (!task || !canSeeTask(req.user, task)) return bad(res, 'Task not found.', 404);
  const updates = db.prepare(`SELECT up.*, u.name AS user_name FROM task_updates up JOIN users u ON u.id = up.user_id
    WHERE up.task_id = ? ORDER BY up.id`).all(task.id);
  const files = taskFiles(task.id);
  for (const up of updates) up.files = files.filter(f => f.update_id === up.id);
  // The other live copies of a multi-person assignment, only those this person can open.
  const group = task.assignment_group_id ? db.prepare(`SELECT t.id, t.assignee_id, a.name AS assignee_name FROM tasks t JOIN users a ON a.id = t.assignee_id
    WHERE t.assignment_group_id = ? AND t.id != ? AND t.deleted_at IS NULL ORDER BY t.id`).all(task.assignment_group_id, task.id)
    .filter(o => canSeeTask(req.user, o)).map(({ id, assignee_name }) => ({ id, assignee_name })) : [];
  const lr = linkedRequestFull(task.id);
  const isAssignee = task.assignee_id === req.user.id;
  const approvers = ownPlainTask(task) ? null : approversFor(task.assignee_id, task.assigned_by, lr);
  res.json({ task, updates, can_edit: canEditTask(req.user, task), approvers, group, group_send_count: groupTargets(req.user, task).length,
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
  if (f.assignee_id) emailAssigned(task.id, u);
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

// The other live copies of the same multi-person assignment that u may also send a note to: only when u manages this
// copy (canEditTask) and isn't its assignee, and only the copies u may edit as well. An assignee's updates stay on
// their own copy.
function groupTargets(u, task) {
  if (!task.assignment_group_id || task.assignee_id === u.id || !canEditTask(u, task)) return [];
  return db.prepare('SELECT * FROM tasks WHERE assignment_group_id = ? AND id != ? AND deleted_at IS NULL ORDER BY id')
    .all(task.assignment_group_id, task.id).filter(o => canEditTask(u, o));
}

// Progress update / status change by the assignee (or the assigner); may carry attached files.
// also_group=1: the note and files also go to the other copies of the assignment (groupTargets); a status or
// progress change stays on this copy.
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
  const others = [true, 1, '1', 'true'].includes(req.body.also_group) && (message || hasFiles) ? groupTargets(u, task) : [];
  const noteKind = message ? 'note' : hasFiles ? 'files' : null; // what the desktop app and emails announce
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET status = ?, progress = ?, completed_at = ?, approved_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(newStatus, newProgress, completedAt, approvedBy, task.id);
    const autoMsg = newStatus !== task.status ? ({ assigned: 'Moved back to not started', in_progress: 'Started work', completed: 'Marked as completed' })[newStatus] : '';
    // A manager/admin completing their own (non-plain) task approves it themselves.
    const selfApproved = newStatus === 'completed' && task.status !== 'completed' && u.id === task.assignee_id && !ownPlainTask(task) && isBoss(u);
    const up = db.prepare('INSERT INTO task_updates (task_id,user_id,message,progress,status,note_kind) VALUES (?,?,?,?,?,?)')
      .run(task.id, u.id, selfApproved ? `Self-approved by ${u.name}` + (message ? ': ' + message : '') : message || autoMsg || (hasFiles && status === undefined && progress === null ? 'Attached files' : 'Progress updated'), progress, newStatus !== task.status ? newStatus : null, noteKind);
    syncRequestWithTask(task.id, newStatus, task.status);
    if (!others.length) return saveUploads(req, { task_id: task.id, update_id: up.lastInsertRowid });
    const links = [{ task_id: task.id, update_id: up.lastInsertRowid }];
    for (const o of others) {
      db.prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`).run(o.id);
      links.push({ task_id: o.id, update_id: db.prepare('INSERT INTO task_updates (task_id,user_id,message,note_kind) VALUES (?,?,?,?)').run(o.id, u.id, message || 'Attached files', noteKind).lastInsertRowid });
    }
    saveSharedUploads(req, links);
  })();
  // One email per copy (its assignee, or the assigner when the assignee posted), for those who turned it on.
  if (noteKind) for (const id of [task.id, ...others.map(o => o.id)]) emailNote(id, u, message, (req.files || []).length);
  res.json({ task: db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(task.id), sent_to: others.length });
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
  emailApprovers(task.id, u);
  taskResponse(res, task.id);
});

// Why canReviewTask said no ("approve" / "send back").
function reviewRefusal(u, task, verb) {
  if (u.id === task.assignee_id) return `You can’t ${verb} your own work.`;
  const doIt = verb === 'send back' ? 'send it back' : verb + ' it';
  const r = linkedRequest(task.id);
  if (isPersonTask(task, r) && r.requested_by === u.id) return `You asked for this, so another lead of the person’s team or a manager has to ${doIt}.`;
  if (r && (task.assigned_by === task.assignee_id || isPersonTask(task, r))) return `Only a lead of ${r.team_name || 'the request’s team'} or a manager can ${doIt}.`;
  if (assignerLeads(task)) return `Only the leads of ${(db.prepare('SELECT name FROM teams WHERE id = ?').get(assigneeTeam(task)) || {}).name || 'the team'} or a manager can ${doIt}.`;
  return `Only the person who assigned this task or a manager can ${doIt}.`;
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
// the team's leads and team managers and for managers/admins.
const canSeeTeamCounts = (u, t) => isBoss(u) || runsTeam(u, t.id);
const OPEN_TEAM_TASKS = `(SELECT COUNT(*) FROM tasks t JOIN users m ON m.id = t.assignee_id WHERE m.team_id = tm.id AND t.status != 'completed' AND t.deleted_at IS NULL)`;
const OPEN_TEAM_REQUESTS = `(SELECT COUNT(*) FROM requests r WHERE r.target_team_id = tm.id AND r.status = 'open' AND r.deleted_at IS NULL)`;
const TEAM_SELECT = `SELECT tm.*, (SELECT COUNT(*) FROM users m WHERE m.team_id = tm.id AND m.active = 1) AS member_count,
  ${OPEN_TEAM_TASKS} AS open_tasks, ${OPEN_TEAM_REQUESTS} AS open_requests FROM teams tm`;
// Connected teams ("works with"): two-way, each pair stored once with the smaller id first.
function connectedTeams(teamId) {
  return db.prepare(`SELECT tm.id, tm.name FROM team_connections c JOIN teams tm ON tm.id = CASE WHEN c.team_a_id = ? THEN c.team_b_id ELSE c.team_a_id END
    WHERE ? IN (c.team_a_id, c.team_b_id) ORDER BY tm.name`).all(teamId, teamId);
}
function teamView(u, t) {
  const leads = leadsOf(t.id);
  // lead_id / lead_name: the first lead, kept for older clients.
  const managers = managersOf(t.id);
  const v = { id: t.id, name: t.name, leads, lead_id: leads.length ? leads[0].id : null, lead_name: leads.length ? leads[0].name : null,
    managers, member_count: t.member_count, mine: u.team_id === t.id, i_lead: leads.some(l => l.id === u.id), i_manage: managers.some(m => m.id === u.id),
    can_see_counts: canSeeTeamCounts(u, t), connections: connectedTeams(t.id) };
  if (v.can_see_counts) { v.open_tasks = t.open_tasks; v.open_requests = t.open_requests; }
  return v;
}
app.get('/api/teams', auth, (req, res) => res.json({ teams: db.prepare(`${TEAM_SELECT} ORDER BY tm.name`).all().map(t => teamView(req.user, t)) }));
app.get('/api/teams/:id', auth, (req, res) => {
  const u = req.user, t = db.prepare(`${TEAM_SELECT} WHERE tm.id = ?`).get(Number(req.params.id));
  if (!t) return bad(res, 'Team not found.', 404);
  const team = teamView(u, t);
  // can_manage: managers/admins (rename, delete, connections, team managers, edit people).
  // can_members: also the team's team managers (add/remove members, set leads).
  const can_members = isBoss(u) || managesTeam(u, t.id);
  const members = db.prepare(`SELECT m.id, m.name, m.role, m.email, m.active, m.protected,
      (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = m.id AND t.status != 'completed' AND t.deleted_at IS NULL) AS open_tasks
    FROM users m WHERE m.team_id = ? ${can_members ? '' : 'AND m.active = 1'}
    ORDER BY m.active DESC, m.id IN (SELECT user_id FROM team_powers WHERE team_id = ?) DESC, m.name`).all(t.id, t.id)
    .map(m => { const x = { ...m, active: !!m.active, is_lead: team.leads.some(l => l.id === m.id), is_manager: team.managers.some(l => l.id === m.id),
        is_owner: isOwner(m), protected: isProtected(m) };
      if (!team.can_see_counts) delete x.open_tasks; return x; });
  const people = table => db.prepare(`SELECT us.id, us.name, us.role, us.email, us.team_id FROM ${table} tl JOIN users us ON us.id = tl.user_id
    WHERE tl.team_id = ? AND us.active = 1 ORDER BY tl.added_at, tl.rowid`).all(t.id).map(l => ({ ...l, member: l.team_id === t.id }));
  const leads = people('team_leads');
  res.json({ team, leads, lead: leads[0] || null, managers: people('team_managers'), members, can_manage: isBoss(u), can_members, can_assign: canSeeTeamCounts(u, t) });
});
// A user with role "lead" who joins a team (or becomes a lead while in one) is added as one of its leads. Callers only
// run this when the team or the role actually changed, so a lead a manager removed stays removed. Returns
// { team_id, team_name, name } when it happened.
function autoLead(userId, by) {
  const m = db.prepare(`SELECT us.name, tm.id AS team_id, tm.name AS team_name FROM users us JOIN teams tm ON tm.id = us.team_id
    WHERE us.id = ? AND us.active = 1 AND us.role = 'lead'`).get(userId);
  if (!m || !db.prepare('INSERT OR IGNORE INTO team_leads (team_id, user_id, added_by) VALUES (?,?,?)').run(m.team_id, userId, by || null).changes) return null;
  syncLegacyLead(m.team_id);
  return { team_id: m.team_id, team_name: m.team_name, name: m.name };
}
// Managers/admins: replace a team's leads (active team leads, managers or admins). Returns an error text or null.
function setTeamLeads(teamId, ids, by) {
  ids = [...new Set(ids.map(Number).filter(Boolean))];
  if (ids.some(id => !validTeamLead(id))) return 'Team leads must be active team leads, managers or admins.';
  db.transaction(() => {
    db.prepare(`DELETE FROM team_leads WHERE team_id = ? AND user_id NOT IN (${ids.map(() => '?').join(',') || 'NULL'})`).run(teamId, ...ids);
    const add = db.prepare('INSERT OR IGNORE INTO team_leads (team_id, user_id, added_by) VALUES (?,?,?)');
    for (const id of ids) add.run(teamId, id, by);
    syncLegacyLead(teamId);
  })();
  return null;
}

function teamFields(req, res, current) {
  const name = req.body.name !== undefined ? str(req.body.name, 120) : current && current.name;
  if (!name) { bad(res, 'Enter a team name.'); return null; }
  if (db.prepare('SELECT 1 FROM teams WHERE name = ? AND id != ?').get(name, current ? current.id : 0)) { bad(res, 'A team with this name already exists.'); return null; }
  // Leads: `lead_ids` (the full list), or the older single `lead_id` (one lead, or none). Undefined = leave them as they are.
  let lead_ids;
  if (Array.isArray(req.body.lead_ids)) lead_ids = req.body.lead_ids;
  else if (req.body.lead_id !== undefined) lead_ids = req.body.lead_id ? [req.body.lead_id] : [];
  if (lead_ids && lead_ids.some(id => !validTeamLead(Number(id)))) { bad(res, 'Team leads must be active team leads, managers or admins.'); return null; }
  return { name, lead_ids };
}
app.post('/api/teams', auth, requireBoss, (req, res) => {
  const f = teamFields(req, res); if (!f) return;
  const r = db.prepare('INSERT INTO teams (name) VALUES (?)').run(f.name);
  if (f.lead_ids) setTeamLeads(r.lastInsertRowid, f.lead_ids, req.user.id);
  syncTeamChats();
  res.json({ team: db.prepare('SELECT * FROM teams WHERE id = ?').get(r.lastInsertRowid) });
});
app.patch('/api/teams/:id', auth, requireBoss, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
  if (!team) return bad(res, 'Team not found.', 404);
  const f = teamFields(req, res, team); if (!f) return;
  db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(f.name, team.id);
  if (f.lead_ids) setTeamLeads(team.id, f.lead_ids, req.user.id);
  syncTeamChats();
  res.json({ team: db.prepare('SELECT * FROM teams WHERE id = ?').get(team.id) });
});
app.delete('/api/teams/:id', auth, requireBoss, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
  if (!team) return bad(res, 'Team not found.', 404);
  // Deleting the team would take the owner out of it.
  const owner = ownerId !== null ? db.prepare('SELECT * FROM users WHERE id = ? AND team_id = ?').get(ownerId, team.id) : null;
  if (owner && ownerRefused(req, res, owner, `delete their team ${team.name}`)) return;
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
// Managers/admins, or a team manager of this team (members and leads only).
function requireTeamPower(req, res, next) {
  return isBoss(req.user) || managesTeam(req.user, Number(req.params.id)) ? next()
    : bad(res, 'Only managers, admins and this team’s team managers can do this.', 403);
}
function memberTarget(req, res) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.userId));
  if (!team || !user || user.removed_at) { bad(res, 'Team or person not found.', 404); return null; }
  if (ownerRefused(req, res, user, req.method === 'DELETE' ? `remove them from team ${team.name}` : `move them to team ${team.name}`)) return null;
  if (user.role === 'admin' && req.user.role !== 'admin') { bad(res, 'Only an admin can change an admin account.', 403); return null; }
  if (!isBoss(req.user)) { // a team manager: only leads and employees, from no team or from the teams they manage
    if (!['lead', 'employee'].includes(user.role)) { bad(res, 'Only a manager can change the team of a manager, team manager or admin.', 403); return null; }
    if (user.team_id && !managesTeam(req.user, user.team_id)) { bad(res, `${user.name} is in a team you don’t manage. Ask a manager to move them.`, 403); return null; }
  }
  return { team, user };
}
app.put('/api/teams/:id/members/:userId', auth, requireTeamPower, (req, res) => {
  const t = memberTarget(req, res); if (!t) return;
  db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(t.team.id, t.user.id);
  const became_lead = t.user.team_id !== t.team.id ? autoLead(t.user.id, req.user.id) : null; // only when they actually moved
  syncTeamChats();
  res.json({ ok: true, became_lead });
});
// Managers/admins and the team's team managers: the full list of this team's leads (replaces the old list).
// A team manager adds only team leads from the teams they manage; leads already set (whoever they are) may stay.
app.put('/api/teams/:id/leads', auth, requireTeamPower, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
  if (!team) return bad(res, 'Team not found.', 404);
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
  // The owner's lead role in this team can only be given or taken by the owner.
  if (ownerId !== null && isLeadOf(ownerId, team.id) !== ids.map(Number).includes(ownerId)
    && ownerRefused(req, res, db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId), `${isLeadOf(ownerId, team.id) ? 'remove them as a lead of' : 'make them a lead of'} team ${team.name}`)) return;
  if (!isBoss(req.user)) {
    const added = ids.map(Number).filter(id => !isLeadOf(id, team.id));
    if (added.some(id => !db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'lead' AND team_id IN ${MANAGED_TEAMS}`).get(id, req.user.id)))
      return bad(res, 'Choose team leads from the teams you manage.', 403);
  }
  const err = setTeamLeads(team.id, ids, req.user.id);
  if (err) return bad(res, err);
  syncTeamChats();
  res.json({ leads: leadsOf(team.id) });
});
// Managers/admins: the full list of this team's team managers (active people with the role team_manager).
app.put('/api/teams/:id/managers', auth, requireBoss, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
  if (!team) return bad(res, 'Team not found.', 404);
  const ids = [...new Set((Array.isArray(req.body.user_ids) ? req.body.user_ids : []).map(Number).filter(Boolean))];
  if (ownerId !== null && ids.includes(ownerId) !== !!db.prepare('SELECT 1 FROM team_managers WHERE team_id = ? AND user_id = ?').get(team.id, ownerId)
    && ownerRefused(req, res, db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId), `change their team manager role in team ${team.name}`)) return;
  if (ids.some(id => !db.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1 AND role = 'team_manager'`).get(id)))
    return bad(res, 'Team managers must be active people with the role “Team manager”. Change their role in the person form first.');
  db.transaction(() => {
    db.prepare(`DELETE FROM team_managers WHERE team_id = ? AND user_id NOT IN (${ids.map(() => '?').join(',') || 'NULL'})`).run(team.id, ...ids);
    const add = db.prepare('INSERT OR IGNORE INTO team_managers (team_id, user_id, added_by) VALUES (?,?,?)');
    for (const id of ids) add.run(team.id, id, req.user.id);
  })();
  syncTeamChats();
  res.json({ managers: managersOf(team.id) });
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
app.delete('/api/teams/:id/members/:userId', auth, requireTeamPower, (req, res) => {
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
  tm.name AS team_name,
  t.assignee_id, a.name AS assignee_name, t.status AS task_status, ap.name AS asked_person_name, wf.name AS withdrawn_from_name
  FROM requests r JOIN users rb ON rb.id = r.requested_by LEFT JOIN teams rt ON rt.id = rb.team_id LEFT JOIN teams tm ON tm.id = r.target_team_id
  LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users ap ON ap.id = r.asked_person_id LEFT JOIN users wf ON wf.id = r.withdrawn_from_id`;
// Archived (deleted) requests are only reachable from History (getAnyRequest).
function getRequest(id) { return db.prepare(`${REQ_SELECT} WHERE r.id = ? AND r.deleted_at IS NULL`).get(id); }
function getAnyRequest(id) { return db.prepare(`${REQ_SELECT} WHERE r.id = ?`).get(id); }
// Who may see a request (board, page, files, History): managers/admins, the requester, members and leads of the
// requester's team, members and leads of the target team, and the person doing (or who was doing) it.
function canSeeRequest(u, r) {
  return isBoss(u) || r.requested_by === u.id || (!!u.team_id && (u.team_id === r.requester_team_id || u.team_id === r.target_team_id))
    || runsTeam(u, r.requester_team_id) || runsTeam(u, r.target_team_id) || r.assignee_id === u.id || r.withdrawn_from_id === u.id;
}
const canSeeRequestFiles = canSeeRequest;
// The same rule as SQL on alias r.
function requestScope(u, archived = false) {
  const live = archived ? '' : ' AND r.deleted_at IS NULL';
  if (isBoss(u)) return { sql: '1=1' + live, params: [] };
  const team = u.team_id || 0;
  return { sql: `(r.requested_by = ? OR r.requested_by IN (SELECT id FROM users WHERE team_id = ?) OR r.target_team_id = ?
      OR r.requested_by IN ${LED_MEMBERS} OR r.target_team_id IN ${LED_TEAMS} OR r.withdrawn_from_id = ?
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
// Members of the request's team, its leads and team managers (even when not members) and managers/admins can take an open request.
function canTakeRequest(u, r) {
  return isBoss(u) || (!!u.team_id && u.team_id === r.target_team_id) || runsTeam(u, r.target_team_id);
}
// The requester takes back a request someone is already doing, until it has been submitted or delivered.
function canWithdraw(u, r) { return r.status === 'assigned' && r.requested_by === u.id && ['assigned', 'in_progress'].includes(r.task_status); }
function requestFlags(u, r) {
  const can_take = r.status === 'open' && canTakeRequest(u, r);
  return {
    can_take,
    take_blocked: can_take && approversFor(u.id, u.id, r).nobody ? nobodyCanApprove(r, u.id) : null,
    can_send_to_team: r.status === 'needs_team' && isBoss(u),
    can_assign: r.status === 'open' && !!r.target_team_id && (isBoss(u) || runsTeam(u, r.target_team_id)),
    i_lead: runsTeam(u, r.target_team_id),
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
  teamFilter(req.query.team, 'r.target_team_id', where, params);        // "Incoming" (and the old team filter)
  teamFilter(req.query.from_team, 'rb.team_id', where, params);         // "Sent": the requester's team
  const q = str(req.query.q, 100);
  if (q) { where.push(`(r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\')`); params.push(likeText(q), likeText(q)); }
  if (req.query.status === 'active') where.push(`r.status IN ('needs_team','open','assigned','delivered')`);
  else if (REQ_STATUSES.includes(req.query.status)) { where.push('r.status = ?'); params.push(req.query.status); }
  const rows = db.prepare(`${REQ_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY CASE r.status WHEN 'needs_team' THEN 0 WHEN 'open' THEN 1 WHEN 'assigned' THEN 2 WHEN 'delivered' THEN 3 ELSE 4 END,
      r.needed_by IS NULL, r.needed_by, r.id DESC LIMIT 1000`).all(...params);
  res.json({ requests: rows.map(r => ({ id: r.id, title: r.title, requested_by: r.requested_by, requested_by_name: r.requested_by_name,
    target_team_id: r.target_team_id, team_name: r.team_name, requester_team_id: r.requester_team_id, requester_team_name: r.requester_team_name,
    needed_by: r.needed_by, status: r.status, assignee_name: r.assignee_name,
    asked_person_name: r.asked_person_name, created_at: r.created_at })) });
});
// Per team: incoming requests waiting for someone (open, or needs a team → "none"), requests the team's members sent that
// aren't finished (needs_team/open/assigned/delivered, the "Not finished" filter), and requests delivered to others in
// the last 7 days (by the team they were sent to).
app.get('/api/requests/summary', auth, (req, res) => {
  const sc = requestScope(req.user), since = new Date(Date.now() - 7 * 864e5).toISOString();
  const from = `FROM requests r JOIN users rb ON rb.id = r.requested_by WHERE ${sc.sql}`;
  const teams = {};
  const put = (id, k, n) => { const t = teams[teamKey(id)] = teams[teamKey(id)] || { incoming: 0, sent: 0, delivered_week: 0 }; t[k] = n; };
  const INCOMING = `r.status IN ('open','needs_team')`, SENT = `r.status IN ('needs_team','open','assigned','delivered')`;
  const DELIVERED = `r.status IN ('delivered','closed') AND r.delivered_at >= ?`;
  for (const r of db.prepare(`SELECT r.target_team_id AS id, COUNT(*) n ${from} AND ${INCOMING} GROUP BY r.target_team_id`).all(...sc.params)) put(r.id, 'incoming', r.n);
  for (const r of db.prepare(`SELECT rb.team_id AS id, COUNT(*) n ${from} AND ${SENT} GROUP BY rb.team_id`).all(...sc.params)) put(r.id, 'sent', r.n);
  for (const r of db.prepare(`SELECT r.target_team_id AS id, COUNT(*) n ${from} AND ${DELIVERED} GROUP BY r.target_team_id`).all(...sc.params, since)) put(r.id, 'delivered_week', r.n);
  const one = (w, ...p) => db.prepare(`SELECT COUNT(*) n ${from} AND ${w}`).get(...sc.params, ...p).n;
  res.json({ teams, all: { incoming: one(INCOMING), sent: one(SENT), delivered_week: one(DELIVERED, since) } });
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
  // Assign list: the team's members for its leads; every active person (with their team) for managers/admins.
  const members = !flags.can_assign ? [] : isBoss(u)
    ? db.prepare(`SELECT us.id, us.name, us.role, us.team_id, tm.name AS team_name FROM users us LEFT JOIN teams tm ON tm.id = us.team_id
        WHERE us.active = 1 ORDER BY us.team_id IS NOT ?, tm.name IS NULL, tm.name, us.name`).all(r.target_team_id)
    : db.prepare(`SELECT us.id, us.name, us.role, us.team_id, tm.name AS team_name FROM users us LEFT JOIN teams tm ON tm.id = us.team_id
        WHERE us.team_id = ? AND us.active = 1 ORDER BY us.name`).all(r.target_team_id)
        .filter(m => m.id === u.id || m.role !== 'team_manager' || managesTeam(u, r.target_team_id)); // see canAssignTo
  const task = r.task_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.task_id) : null;
  const teams = flags.can_send_to_team ? db.prepare('SELECT id, name, (SELECT COUNT(*) FROM team_leads WHERE team_id = teams.id) AS lead_count FROM teams ORDER BY name').all() : [];
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
    const p = db.prepare(`SELECT us.*, tm.name AS team_name FROM users us LEFT JOIN teams tm ON tm.id = us.team_id
      WHERE us.id = ?`).get(Number(req.body.person_id));
    if (!p || !p.active) return bad(res, 'Choose an active person.');
    if (p.id === u.id) return bad(res, 'You can’t send a request to yourself. Add a task for yourself instead.');
    if (!p.team_id) return bad(res, `${p.name} isn’t in a team yet, so they can’t be asked directly.`);
    if (!allowedTargetTeams(u).some(t => t.id === p.team_id))
      return bad(res, `You can only ask people in your own team or in teams connected to it. ${p.team_name} isn’t one of them.`, 403);
    const pseudo = { asked_person_id: p.id, requested_by: u.id, target_team_id: p.team_id, team_name: p.team_name };
    if (approversFor(p.id, u.id, pseudo).nobody) return bad(res, nobodyCanApprove(pseudo, p.id), 409);
    let id, taskId;
    db.transaction(() => {
      id = db.prepare(`INSERT INTO requests (title, description, needed_by, requested_by, target_team_id, status, asked_person_id)
        VALUES (?,?,?,?,?,'assigned',?)`).run(title, description, needed_by, u.id, p.team_id, p.id).lastInsertRowid;
      const desc = [description, `Document request #${id} from ${u.name}, sent to you.`].filter(Boolean).join('\n\n');
      taskId = db.prepare('INSERT INTO tasks (title, description, assignee_id, assigned_by, deadline) VALUES (?,?,?,?,?)')
        .run(title, desc, p.id, u.id, needed_by).lastInsertRowid;
      db.prepare('UPDATE requests SET task_id = ? WHERE id = ?').run(taskId, id);
      db.prepare('INSERT INTO task_updates (task_id,user_id,message,status) VALUES (?,?,?,?)').run(taskId, u.id, `${u.name} asked ${p.name} (document request #${id})`, 'assigned');
      db.prepare('INSERT INTO request_events (request_id, user_id, message) VALUES (?,?,?)').run(id, u.id, `Sent to ${p.name} by ${u.name}`);
      saveUploads(req, { request_id: id });
    })();
    emailAssigned(taskId, u);
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

// Why a request can no longer be taken or assigned (e.g. two leads clicked at once): "Already assigned to <name> by <lead>."
function takenMessage(requestId) {
  const x = db.prepare(`SELECT r.status, a.id AS aid, a.name AS assignee, b.id AS bid, b.name AS by FROM requests r
    LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users b ON b.id = t.assigned_by WHERE r.id = ?`).get(requestId);
  if (!x || !x.assignee) return x && x.status !== 'open' ? 'This request is no longer open.' : 'Someone else has already taken this request.';
  return x.aid === x.bid ? `Already taken by ${x.assignee}.` : `Already assigned to ${x.assignee} by ${x.by}.`;
}
// Turn an open request into a task assigned to `assignee` (assigned_by = `by`). Only one claim can win.
function createRequestTask(r, assignee, by) {
  return db.transaction(() => {
    const desc = [r.description, `Document request #${r.id} from ${r.requested_by_name}${r.team_name ? ' for ' + r.team_name : ''}.`].filter(Boolean).join('\n\n');
    const taskId = db.prepare(`INSERT INTO tasks (title, description, assignee_id, assigned_by, deadline) VALUES (?,?,?,?,?)`)
      .run(r.title, desc, assignee.id, by.id, r.needed_by).lastInsertRowid;
    const claimed = db.prepare(`UPDATE requests SET status = 'assigned', task_id = ? WHERE id = ? AND status = 'open'`).run(taskId, r.id);
    if (!claimed.changes) { const e = new Error(takenMessage(r.id)); e.status = 409; throw e; }
    db.prepare('INSERT INTO task_updates (task_id,user_id,message,status) VALUES (?,?,?,?)').run(taskId, by.id,
      assignee.id === by.id ? `Took document request #${r.id}` : `Assigned from document request #${r.id} to ${assignee.name}`, 'assigned');
    return taskId;
  })();
}
function sendRequestTask(res, r, assignee, by) {
  try { const taskId = createRequestTask(r, assignee, by); emailAssigned(taskId, by); res.json({ request: getRequest(r.id), task_id: taskId }); }
  catch (e) { if (e.status) return bad(res, e.message, e.status); throw e; }
}
app.post('/api/requests/:id/take', auth, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r) return bad(res, 'Request not found.', 404);
  if (r.status === 'needs_team') return bad(res, 'A manager hasn’t chosen a team for this request yet.', 409);
  if (r.status !== 'open') return bad(res, takenMessage(r.id), 409);
  if (!canTakeRequest(u, r)) return bad(res, 'Only members of the team this request is for, its leads and managers can take it.', 403);
  if (approversFor(u.id, u.id, r).nobody) return bad(res, nobodyCanApprove(r, u.id), 409);
  sendRequestTask(res, r, u, u);
});
app.post('/api/requests/:id/assign', auth, (req, res) => {
  const u = req.user, r = getRequest(Number(req.params.id));
  if (!r) return bad(res, 'Request not found.', 404);
  if (r.status === 'needs_team') return bad(res, 'Send this request to a team first.', 409);
  if (!isBoss(u) && !runsTeam(u, r.target_team_id)) return bad(res, 'Only managers and the team’s leads and team managers can assign this request.', 403);
  if (r.status !== 'open') return bad(res, takenMessage(r.id), 409);
  const a = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.body.user_id));
  if (!a || !a.active) return bad(res, 'Choose an active person.');
  // Managers: anyone. The lead: the team's members, or themself (same as "Take this task").
  if (!isBoss(u) && a.id !== u.id && a.team_id !== r.target_team_id) return bad(res, 'Choose an active member of the request’s team.');
  if (!isBoss(u) && a.id !== u.id && isTM(a) && !managesTeam(u, r.target_team_id))
    return bad(res, 'A team manager’s work is approved by another team manager or a manager, so only they can assign it to a team manager.', 403);
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
// Restore / delete permanently: managers/admins, and team managers for archived items of the teams they manage
// (a task's team is its assignee's team, a request's team the team it was sent to).
const canManageArchived = (u, teamId) => isBoss(u) || managesTeam(u, teamId);
const ARCHIVE_REFUSED = 'Only managers, admins and the team’s team managers can restore or permanently delete this.';
app.post('/api/requests/:id/restore', auth, (req, res) => {
  const u = req.user, r = getAnyRequest(Number(req.params.id));
  if (!r || !r.deleted_at || !canSeeRequest(u, r)) return bad(res, 'Only a deleted request can be restored.', 404);
  if (!canManageArchived(u, r.target_team_id)) return bad(res, ARCHIVE_REFUSED, 403);
  db.transaction(() => {
    db.prepare('UPDATE requests SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(r.id);
    db.prepare('INSERT INTO request_events (request_id, user_id, message) VALUES (?,?,?)').run(r.id, u.id, `Restored by ${u.name}`);
  })();
  res.json({ request: getRequest(r.id) });
});
app.delete('/api/requests/:id/permanent', auth, (req, res) => {
  const r = getAnyRequest(Number(req.params.id));
  if (!r || !r.deleted_at || !canSeeRequest(req.user, r)) return bad(res, 'Only a deleted request can be deleted permanently.', 404);
  if (!canManageArchived(req.user, r.target_team_id)) return bad(res, ARCHIVE_REFUSED, 403);
  const stored = db.prepare('SELECT stored_name FROM files WHERE request_id = ?').all(r.id);
  db.prepare('DELETE FROM requests WHERE id = ?').run(r.id); // its activity and attachments go with it; a linked task stays
  removeStoredFiles(stored);
  res.json({ ok: true });
});
// Restoring a task that came from a request puts it back on that request, if the request is still waiting for it
// (open again after a delete/give back, or cancelled by the requester withdrawing it from this person).
// Archived tasks are visible in History by the same rule as live ones (taskScope with archived).
function archivedTaskVisible(u, task) {
  const s = taskScope(u, true);
  return !!db.prepare(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${s.sql}`).get(task.id, ...s.params);
}
app.post('/api/tasks/:id/restore', auth, (req, res) => {
  const u = req.user, task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !task.deleted_at || !archivedTaskVisible(u, task)) return bad(res, 'Only a deleted task can be restored.', 404);
  if (!canManageArchived(u, assigneeTeam(task))) return bad(res, ARCHIVE_REFUSED, 403);
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
app.delete('/api/tasks/:id/permanent', auth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !task.deleted_at || !archivedTaskVisible(req.user, task)) return bad(res, 'Only a deleted task can be deleted permanently.', 404);
  if (!canManageArchived(req.user, assigneeTeam(task))) return bad(res, ARCHIVE_REFUSED, 403);
  const stored = db.prepare('SELECT stored_name FROM files WHERE task_id = ?').all(task.id);
  const shared = db.prepare('SELECT file_id FROM task_files WHERE task_id = ?').all(task.id).map(l => l.file_id);
  db.transaction(() => {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id); // its updates, own files and file links go with it
    // A shared assignment file is removed only when no other copy (live or archived) still links to it.
    for (const id of shared) if (!db.prepare('SELECT 1 FROM task_files WHERE file_id = ?').get(id)) {
      stored.push(db.prepare('SELECT stored_name FROM files WHERE id = ?').get(id));
      db.prepare('DELETE FROM files WHERE id = ?').run(id);
    }
  })();
  removeStoredFiles(stored.filter(Boolean));
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

// Team chats: one per team; members = the team's active members plus all its leads and team managers. Called after
// every change to teams or people.
function syncTeamChats() {
  const changed = [];
  db.transaction(() => {
    for (const t of db.prepare('SELECT id, name FROM teams').all()) {
      let c = db.prepare(`SELECT * FROM conversations WHERE type = 'team' AND team_id = ?`).get(t.id);
      if (!c) c = db.prepare(`INSERT INTO conversations (type, name, team_id) VALUES ('team', ?, ?) RETURNING *`).get(t.name, t.id);
      else if (c.name !== t.name) { db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(t.name, c.id); changed.push(...memberIds(c.id)); }
      const want = db.prepare('SELECT id FROM users WHERE active = 1 AND (team_id = ? OR id IN (SELECT user_id FROM team_powers WHERE team_id = ?))').all(t.id, t.id).map(r => r.id);
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
function taskFileVisible(u, taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (task && canSeeTask(u, task)) return true;
  // files of a delivered request's task are visible to the people on that request
  const r = db.prepare(`${REQ_SELECT} WHERE r.task_id = ? AND r.status IN ('delivered','closed')`).get(taskId);
  return !!r && canSeeRequestFiles(u, r);
}
app.get('/api/files/:id', auth, (req, res) => {
  const u = req.user, f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
  let ok = false, inline = false;
  if (f && f.message_id) { // chat files: members of the conversation only, and only while the message isn't deleted
    const m = db.prepare('SELECT conversation_id, deleted_at FROM messages WHERE id = ?').get(f.message_id);
    ok = !!m && !m.deleted_at && !!chatMember(u, m.conversation_id);
    inline = ok && req.query.inline === '1' && IMAGE_MIME.includes(f.mime); // image thumbnails
  } else if (f && f.task_id) {
    ok = taskFileVisible(u, f.task_id);
  } else if (f && f.request_id) {
    const r = getRequest(f.request_id);
    ok = !!r && canSeeRequestFiles(u, r);
  } else if (f) { // shared assignment files: visible to anyone who can see one of the copies they're linked to
    ok = db.prepare('SELECT task_id FROM task_files WHERE file_id = ?').all(f.id).some(l => taskFileVisible(u, l.task_id));
  }
  if (!ok || !/^[0-9a-f]{32}$/.test(f.stored_name)) return bad(res, 'File not found.', 404);
  const file = path.join(UPLOAD_DIR, f.stored_name);
  // The type comes from the stored bytes, so a renamed .html/.svg/.js is just bytes; only real images may be inline.
  const type = sniffFile(file);
  inline = inline && IMAGE_MIME.includes(type);
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  if (inline) {
    res.set({ 'Cache-Control': 'private, max-age=86400' });
    res.type(type);
    return res.sendFile(file, err => { if (err && !res.headersSent) bad(res, 'File not found.', 404); });
  }
  res.download(file, f.original_name, { headers: { 'Content-Type': type } }, err => {
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
  for (const r of rows) if (r.deleted_at) { r.status = 'deleted'; r.can_restore = canManageArchived(u, r.team_id); }
  const person = Number(q.person), team = Number(q.team);
  if (person) rows = rows.filter(r => [r.assignee_id, r.assigned_by, r.requested_by].includes(person));
  if (team) rows = rows.filter(r => r.team_id === team);
  else if (q.team === 'none') rows = rows.filter(r => !r.team_id); // team tab "No team"

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
// It also runs every 10 minutes for the "Still unassigned" emails (sent once per request, to the team's leads and team managers who turned them on).
function remindStaleRequests() {
  const flagged = db.prepare(`UPDATE requests SET reminded_at = ? WHERE status = 'open' AND deleted_at IS NULL AND reminded_at IS NULL
    AND MAX(created_at, COALESCE((SELECT MAX(e.created_at) FROM request_events e WHERE e.request_id = requests.id), '')) < datetime('now', '-24 hours')
    RETURNING id, title, target_team_id`).all(new Date().toISOString());
  for (const r of flagged) {
    const team = db.prepare('SELECT name FROM teams WHERE id = ?').get(r.target_team_id);
    for (const l of leadsOf(r.target_team_id).concat(managersOf(r.target_team_id))) notifyEmail(l.id, 'email_unassigned', `Still unassigned: ${r.title}`, 'A request is still unassigned',
      [`"${r.title}" for ${team ? team.name : 'your team'} has been waiting for more than 24 hours. Assign it to someone, or take it yourself.`],
      'Open the request', `requests/${r.id}`);
  }
}
setInterval(remindStaleRequests, 10 * 60e3).unref();
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
  const team_requests = db.prepare(`SELECT r.id, r.title, tm.name AS team_name, tm.id IN ${LED_TEAMS} AS i_lead FROM requests r JOIN teams tm ON tm.id = r.target_team_id
    WHERE r.status = 'open' AND r.deleted_at IS NULL AND r.requested_by != ? AND (r.target_team_id = ? OR tm.id IN ${LED_TEAMS}) ORDER BY r.id DESC LIMIT 100`)
    .all(u.id, u.id, u.team_id || 0, u.id).map(r => ({ ...r, i_lead: !!r.i_lead }));
  // Open requests for teams the user leads (part of the badge), and the ones flagged "still unassigned" for the
  // team's lead and for managers/admins.
  const assign_requests = db.prepare(`${LEAD_OPEN_REQUESTS} AND tm.id IN ${LED_TEAMS} ORDER BY r.id DESC LIMIT 100`).all(u.id)
    .map(r => ({ id: r.id, title: r.title, team_name: r.team_name }));
  const unassigned_reminders = db.prepare(`${LEAD_OPEN_REQUESTS} AND r.reminded_at IS NOT NULL ${isBoss(u) ? '' : `AND tm.id IN ${LED_TEAMS}`}
    ORDER BY r.id DESC LIMIT 100`).all(...(isBoss(u) ? [] : [u.id])).map(r => ({ id: r.id, title: r.title, team_name: r.team_name }));
  const ready_requests = db.prepare(`SELECT id, title FROM requests WHERE requested_by = ? AND status = 'delivered' AND deleted_at IS NULL ORDER BY id DESC LIMIT 100`).all(u.id);
  // Managers/admins: requests posted without a team, waiting for someone to choose one.
  const needs_team_requests = isBoss(u) ? db.prepare(`SELECT id, title FROM requests WHERE status = 'needs_team' AND deleted_at IS NULL AND requested_by != ?
    ORDER BY id DESC LIMIT 100`).all(u.id) : [];
  // Requests sent straight to a member of a team the user leads ("<requester> (<team>) asked <person>").
  const team_asks = db.prepare(`SELECT r.id, r.title, rb.name AS requested_by_name, rt.name AS requester_team_name, ap.name AS person_name
    FROM requests r JOIN teams tm ON tm.id = r.target_team_id JOIN users rb ON rb.id = r.requested_by LEFT JOIN teams rt ON rt.id = rb.team_id
    JOIN users ap ON ap.id = r.asked_person_id
    WHERE r.status = 'assigned' AND r.deleted_at IS NULL AND tm.id IN ${LED_TEAMS} AND r.requested_by != ? AND r.asked_person_id != ? ORDER BY r.id DESC LIMIT 100`).all(u.id, u.id, u.id);
  // Requests withdrawn in the last 3 days from this person, or from a member of a team the user leads.
  const withdrawn = db.prepare(`SELECT r.id, r.title, rb.name AS requested_by_name FROM requests r JOIN users rb ON rb.id = r.requested_by
    LEFT JOIN teams tm ON tm.id = r.target_team_id
    WHERE r.status = 'cancelled' AND r.deleted_at IS NULL AND r.withdrawn_from_id IS NOT NULL AND r.closed_at >= ? AND r.requested_by != ?
      AND (r.withdrawn_from_id = ? OR tm.id IN ${LED_TEAMS}) ORDER BY r.id DESC LIMIT 100`)
    .all(new Date(Date.now() - 3 * 864e5).toISOString(), u.id, u.id, u.id);
  // Notes and files added in the last 3 days by someone else: on my tasks, and on tasks I assigned when the assignee
  // posted (kind: note|files). The desktop app notifies each id once.
  const task_notes = db.prepare(`SELECT up.id, up.task_id, t.title, p.name AS by_name, up.note_kind AS kind
    FROM task_updates up JOIN tasks t ON t.id = up.task_id JOIN users p ON p.id = up.user_id
    WHERE up.note_kind IS NOT NULL AND up.user_id != ? AND t.deleted_at IS NULL AND up.created_at >= datetime('now','-3 days')
      AND (t.assignee_id = ? OR (t.assigned_by = ? AND up.user_id = t.assignee_id)) ORDER BY up.id DESC LIMIT 100`).all(u.id, u.id, u.id);
  res.json({ user: publicUser(u), open: counts.open || 0, overdue: counts.overdue || 0, tasks, recently_approved, approvals, team_requests,
    ready_requests, needs_team_requests, assign_requests, unassigned_reminders, team_asks, withdrawn, task_notes, chat_unread: chatUnreadTotal(u.id) });
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
    : db.prepare(`${LEAD_OPEN_REQUESTS} AND tm.id IN ${LED_TEAMS} ORDER BY r.needed_by IS NULL, r.needed_by, r.id LIMIT 50`).all(u.id);

  res.json({ totals, projects, people, due_soon, awaiting_me, to_assign });
});

app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.get('*', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => console.log(`TaskDesk running on http://localhost:${PORT}`));

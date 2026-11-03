const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const multer = require('multer');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const keys = require('./keys');

// master.key (Security A2): encrypts uploaded files and the database. Without it nothing can be read, so don't start.
let MASTER_KEY;
try { MASTER_KEY = keys.loadMasterKey(); console.log(`[keys] master.key loaded from ${keys.DIR}`); }
catch (e) { console.error('[keys] ' + e.message); process.exit(1); }
// The database is encrypted (dbfile.js). A plain database or a key that doesn't fit stops the server with the reason.
let db;
try { db = require('./db'); } catch (e) { console.error('[db] ' + e.message); process.exit(1); }
const mailer = require('./mailer');
const filecrypt = require('./filecrypt');
filecrypt.init(MASTER_KEY);
const scanner = require('./scanner');
const passwords = require('./passwords'); // bcrypt in worker threads, so a sign-in rush doesn't freeze the server (Scale)
// Async route handlers: an error becomes a clean 500 (an unhandled promise rejection would stop the process).
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (e && e.code === 'BUSY') return res.status(503).json({ error: e.message });
  console.error(`[error] ${req.method} ${req.path}:`, e && e.stack || e);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Try again.' });
});

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_DAYS = 30;
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');

// Behind Nginx (AWS) or any proxy: how many proxy hops to believe for the client address (req.ip: audit log, sign-in lockout
// and per-address limits). Default 1, which is right for both the laptop (Docker's gateway hop) and the cloud (Nginx on the
// host sets X-Forwarded-For to the real client, then reaches the container through Docker's gateway). TRUST_PROXY may also be
// a number, "loopback", or a comma-separated list of addresses/CIDRs. Wrong value = every user looks like the proxy.
app.set('trust proxy', (v => /^\d+$/.test(v) ? Number(v) : v === 'false' ? false : v.includes(',') ? v.split(',').map(x => x.trim()) : v)(String(process.env.TRUST_PROXY || '1').trim()));
// Security headers on every response (Security A1). The CSP allows only this server's own script, styles, images and
// connections. No inline scripts and no <style> blocks; only style="…" attributes are allowed (style-src-attr), as the
// page templates use them for small layout tweaks (they can't run code or use selectors). File downloads set their
// own stricter CSP (default-src 'none'; sandbox) in /api/files/:id.
app.disable('x-powered-by');
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'", "img-src 'self'",
  "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
app.use((req, res, next) => {
  res.set({ 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  next();
});
// Health check for the load balancer (AWS prep): no sign-in, no data. 200 only when the database opens and answers a query,
// else 503. Mounted before CSRF, static files, auth and every limiter, and it never writes an audit entry or touches a
// session, so a check every 30 seconds changes nothing. HEALTH_TEST_FAIL=1 (tests only) makes the database check fail.
const healthQuery = db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM users LIMIT 1)'); // reads a table page, so a broken file or key fails
app.all('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').json({ ok: false });
  let ok = false;
  try { if (process.env.HEALTH_TEST_FAIL === '1') throw new Error('test'); ok = Number.isInteger(healthQuery.get().n); } catch (e) { ok = false; }
  res.status(ok ? 200 : 503).json({ ok });
});
app.use('/api/users/import/commit', express.json({ limit: '2mb' })); // up to 2000 rows; every other route keeps 200 KB
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
// CSRF (Security A1). Every POST/PUT/PATCH/DELETE to /api:
// - is refused when the browser's Origin header names another site;
// - with a session cookie, must carry X-CSRF-Token = csrfFor(session token), which the page gets from /api/me and
//   /api/login (the web app, also inside the desktop app's window, sends it on every change). Sign-in, "Forgot
//   password" and set-password links have no session and are exempt from the token (the Origin check still applies).
// The desktop app's own calls are all GETs (summary, stream, version), so it needs nothing.
const csrfFor = sid => crypto.createHmac('sha256', String(sid)).update('taskdesk-csrf').digest('base64url');
const CSRF_EXEMPT = new Set(['/api/login', '/api/login/code', '/api/password/forgot', '/api/password/check', '/api/password/set']);
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('Origin');
  if (origin) { let host = null; try { host = new URL(origin).host; } catch (e) { /* "null" or junk */ }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request refused.' }); }
  const sid = req.cookies.sid;
  if (!sid || CSRF_EXEMPT.has(req.baseUrl + req.path)) return next();
  const want = Buffer.from(csrfFor(sid)), got = Buffer.from(String(req.get('X-CSRF-Token') || ''));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want))
    return res.status(403).json({ error: 'This page is out of date. Reload it and try again.', code: 'csrf' });
  next();
});
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
// MOVED_TO (AWS move): the https address TaskDesk now lives at. Announced in /api/version and /api/my-summary so desktop apps
// (1.0.18+) switch to it by themselves. Must be https://host[/path]; anything else is ignored with a log line (the app would
// refuse it anyway). TASKDESK_TEST_ALLOW_HTTP_MOVE=1 (tests only) also lets http through.
const MOVED_TO = (v => {
  if (!v) return '';
  try {
    const u = new URL(v);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && process.env.TASKDESK_TEST_ALLOW_HTTP_MOVE === '1')) || !u.hostname || u.username || u.password || u.search || u.hash) throw new Error('bad');
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch (e) { console.error('[moved] MOVED_TO ignored: it must be an https:// address without user name, ? or #.'); return ''; }
})(String(process.env.MOVED_TO || '').trim());
if (MOVED_TO) console.log(`[moved] announcing the new address ${MOVED_TO} to desktop apps`);
app.get('/api/version', (req, res) => { noCache(res); res.json(MOVED_TO ? { build: BUILD_ID, moved_to: MOVED_TO } : { build: BUILD_ID }); });
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
    managed_teams: isTM(u) ? managedTeams(u.id) : [], locked: isOwner(u), protected: !!u.protected };
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
// Stored files are encrypted (filecrypt.js): the type is read from the decrypted first bytes.
function sniffFile(file) {
  try { return sniffBytes(filecrypt.readHead(file, 16)); } catch (e) { return 'application/octet-stream'; }
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Uploads are scanned for viruses and encrypted while they arrive (Security A2), so no plain copy ever reaches the disk
// and nothing is kept unless ClamAV says it's clean (scanner.js). The storage engine gives multer: filename (random),
// path, size (plain bytes) and mime (from the first plain bytes). An infected file, or a scanner that can't be
// reached, fails the whole request (multer then removes the request's other files too).
const VIRUS_MSG = 'This file was blocked by the virus scanner.';
const SCANNER_DOWN_MSG = 'Files can’t be uploaded right now because the virus scanner isn’t running. Try again in a few minutes, or tell an admin.';
const userError = (message, status) => Object.assign(new Error(message), { userMessage: true, status });
const encryptedStorage = {
  _handleFile(req, file, cb) {
    const filename = crypto.randomBytes(16).toString('hex'), dest = path.join(UPLOAD_DIR, filename);
    let size = 0, head = Buffer.alloc(0);
    file.stream.on('data', d => { size += d.length; if (head.length < 16) head = Buffer.concat([head, d.subarray(0, 16 - head.length)]); });
    const scan = scanner.scan();
    pipeline(file.stream, scan.stream, filecrypt.encryptStream(), fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
      .then(() => scan.verdict)
      .then(v => {
        if (v.clean) return cb(null, { filename, path: dest, size, mime: sniffBytes(head) });
        const name = cleanFileName(file.originalname);
        console.log(`[scan] blocked "${name}" from user ${req.user && req.user.id}: ${v.signature}`);
        audit(req, 'virus_blocked', { target: { type: 'file', name }, details: `${v.signature}; ${size} bytes; ${req.method} ${req.originalUrl}` });
        fs.unlink(dest, () => cb(userError(VIRUS_MSG, 422)));
      })
      .catch(err => {
        if (err.code === 'SCANNER_DOWN') console.error(`[scan] upload refused: ${err.message}`);
        const e = err.code === 'SCANNER_DOWN' ? userError(SCANNER_DOWN_MSG, 503)
          : err.code === 'SCAN_TOO_BIG' ? userError('This file is too large for the virus scanner.', 400) : err;
        fs.unlink(dest, () => cb(e));
      });
  },
  _removeFile(req, file, cb) { fs.unlink(file.path, () => cb(null)); }
};
const upload = multer({
  storage: encryptedStorage,
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
    bad(res, msg, err.userMessage && err.status || 400);
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
    ins.run(name, f.filename, f.size, f.mime,
      req.user.id, link.task_id || null, link.update_id || null, link.request_id || null, link.message_id || null);
  }
}
// Files for several copies of an assignment: each file is stored once (no owning task) and linked to an update on
// every copy in task_files. links: [{ task_id, update_id }].
function saveSharedUploads(req, links) {
  const ins = db.prepare('INSERT INTO files (original_name, stored_name, size, mime, uploaded_by) VALUES (?,?,?,?,?)');
  const link = db.prepare('INSERT INTO task_files (file_id, task_id, update_id) VALUES (?,?,?)');
  for (const f of req.files || []) {
    const id = ins.run(cleanFileName(f.originalname), f.filename, f.size, f.mime, req.user.id).lastInsertRowid;
    for (const l of links) link.run(id, l.task_id, l.update_id);
  }
}
// A task's files: its own, plus shared assignment files linked to it.
const taskFiles = taskId => db.prepare(`SELECT id, original_name, size, update_id, uploaded_by, created_at FROM files WHERE task_id = ?
  UNION ALL SELECT f.id, f.original_name, f.size, tf.update_id, f.uploaded_by, f.created_at FROM task_files tf JOIN files f ON f.id = tf.file_id
  WHERE tf.task_id = ? ORDER BY id`).all(taskId, taskId);

// ---------- audit log (Security A1) ----------
// Append-only record of security-relevant events: who (actor, or empty for someone not signed in), when (UTC), from
// which IP, what (action), on what (target type/id/name) and details. Names are copied in, so entries stay readable
// after people or teams are removed. Triggers in db.js refuse UPDATE/DELETE; there is no endpoint to change entries.
function audit(req, action, { actor, target, details } = {}) {
  const a = actor !== undefined ? actor : req && req.user;
  try {
    db.prepare(`INSERT INTO audit_log (actor_id, actor_name, ip, action, target_type, target_id, target_name, details) VALUES (?,?,?,?,?,?,?,?)`)
      .run(a ? a.id : null, a ? a.name : null, req && req.ip ? String(req.ip).replace(/^::ffff:/, '') : null, action, target ? target.type : null, target && target.id != null ? target.id : null,
        target ? target.name || null : null, details == null ? '' : typeof details === 'string' ? details : JSON.stringify(details));
  } catch (e) { console.error('[audit] could not record', action, e.message); }
}
const personTarget = u => u ? { type: 'person', id: u.id, name: u.name } : null;
const teamLabel = id => id ? ((db.prepare('SELECT name FROM teams WHERE id = ?').get(id) || {}).name || `team #${id}`) : 'no team';
const personLabel = id => id ? ((db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || `person #${id}`) : 'nobody';

// ---------- auth ----------
const loginAttempts = new Map();
// Sign-in is async since the password check moved to worker threads (Scale), so two things keep the limits honest:
// - attempts on the SAME account run one at a time (serialPerKey), so each sees the previous result and the 8-failure lockout
//   can't be skipped by sending many guesses at once;
// - the per-address limit counts FAILED attempts only (10 failures from one address within 15 minutes, a successful sign-in
//   from it starts the count again, as before), plus at most LOGIN_INFLIGHT_MAX sign-ins from one address being checked at
//   the same moment. A whole office signing in at 9:00 isn't blocked; a flood of guesses is.
// LOGIN_IP_LIMIT (default 10) can be raised if everybody reaches the server through one address (a proxy or NAT that
// doesn't pass the client's address on).
const LOGIN_IP_LIMIT = (n => Number.isFinite(n) && n >= 1 ? Math.round(n) : 10)(Number(process.env.LOGIN_IP_LIMIT));
const LOGIN_INFLIGHT_MAX = 100, loginInflight = new Map(), loginChains = new Map();
function ipBlocked(ip) { const r = loginAttempts.get(ip); return !!r && Date.now() <= r.reset && r.n > LOGIN_IP_LIMIT; }
function ipNoteFailure(ip) {
  const now = Date.now(), r = loginAttempts.get(ip) || { n: 0, reset: now + 15 * 60e3 };
  if (now > r.reset) { r.n = 0; r.reset = now + 15 * 60e3; }
  r.n++; loginAttempts.set(ip, r);
}
function serialPerKey(key, fn) {
  const run = (loginChains.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {}); loginChains.set(key, tail);
  tail.then(() => { if (loginChains.get(key) === tail) loginChains.delete(key); });
  return run;
}
setInterval(() => { const now = Date.now(); for (const [ip, r] of loginAttempts) if (now > r.reset) loginAttempts.delete(ip); }, 10 * 60e3).unref();
function rateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { n: 0, reset: now + 15 * 60e3 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 15 * 60e3; }
  rec.n++; loginAttempts.set(ip, rec);
  return rec.n > 10;
}

// Account lockout: 8 failed sign-ins for one email within 15 minutes lock it for 15 minutes (even the right password
// is refused). Kept in the database (login_failures, login_locks), so a restart doesn't unlock. A successful sign-in
// clears the failures; a set-password link (welcome / Forgot password) also lifts the lock. The per-IP limit above
// still applies first.
const LOCK_FAILS = 8, LOCK_MINUTES = 15;
const LOCKED_MSG = 'Too many attempts. Try again in 15 minutes or use Forgot password.';
const loginKey = email => String(email || '').trim().toLowerCase().slice(0, 200);
const isLocked = key => !!db.prepare(`SELECT 1 FROM login_locks WHERE email = ? AND locked_until > datetime('now')`).get(key);
function recordLoginFailure(key) { // returns true when this failure locks the account
  return db.transaction(() => {
    db.prepare('INSERT INTO login_failures (email) VALUES (?)').run(key);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > datetime('now', ?)`).get(key, `-${LOCK_MINUTES} minutes`).n;
    db.prepare(`DELETE FROM login_failures WHERE at < datetime('now', '-1 day')`).run(); // keep the table small
    if (n < LOCK_FAILS) return false;
    db.prepare(`INSERT INTO login_locks (email, locked_until) VALUES (?, datetime('now', ?)) ON CONFLICT(email) DO UPDATE SET locked_until = excluded.locked_until`)
      .run(key, `+${LOCK_MINUTES} minutes`);
    db.prepare('DELETE FROM login_failures WHERE email = ?').run(key);
    return true;
  })();
}
function clearLoginFailures(key, unlock) {
  db.prepare('DELETE FROM login_failures WHERE email = ?').run(key);
  if (unlock) db.prepare('DELETE FROM login_locks WHERE email = ?').run(key);
}

// Idle sign-out: a session ends after 8 hours without activity. Background calls don't count as activity: the
// desktop app's checks (/api/my-summary, /api/stream) and the web app's own refreshes (header X-Background: 1, e.g.
// chat polling, unread counts, mark as read). last_active_at is written at most once a minute.
const IDLE_HOURS = 8;
const BACKGROUND_PATHS = new Set(['/api/my-summary', '/api/stream']);
const isBackground = req => BACKGROUND_PATHS.has(req.path) || req.get('X-Background') === '1';
function auth(req, res, next) {
  const token = req.cookies.sid;
  if (!token) return bad(res, 'Please sign in.', 401);
  const row = db.prepare(`SELECT u.*, s.last_active_at AS s_active, s.needs_2fa_setup AS s_setup,
      s.last_active_at IS NOT NULL AND s.last_active_at < datetime('now', ?) AS s_idle,
      s.last_active_at IS NULL OR s.last_active_at < datetime('now', '-60 seconds') AS s_touch
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(`-${IDLE_HOURS} hours`, token);
  if (!row) return bad(res, 'Your session has ended. Please sign in again.', 401);
  if (row.s_idle) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return bad(res, `You were signed out after ${IDLE_HOURS} hours without activity. Please sign in again.`, 401);
  }
  // Older sessions without a value get one on their first request, even a background one.
  if (row.s_touch && (!isBackground(req) || !row.s_active)) db.prepare(`UPDATE sessions SET last_active_at = datetime('now') WHERE token = ?`).run(token);
  const { s_active, s_idle, s_touch, s_setup, ...user } = row;
  // An admin/manager signed in without two-step verification: only the setup (and sign out) until it's on.
  if (s_setup && needsTwoStep(user) && !user.totp_enabled_at && !SETUP_PATHS.has(req.path))
    return res.status(403).json({ error: 'Set up two-step verification first.', code: '2fa_setup' });
  req.user = user;
  next();
}
const SETUP_PATHS = new Set(['/api/me', '/api/me/2fa', '/api/me/2fa/setup', '/api/me/2fa/enable']);
function requireBoss(req, res, next) { return isBoss(req.user) ? next() : bad(res, 'Only managers and admins can do this.', 403); }
function requireAdmin(req, res, next) { return req.user.role === 'admin' ? next() : bad(res, 'Only admins can do this.', 403); }

app.post('/api/login', ah(async (req, res) => {
  const email = str(req.body.email, 200), password = typeof req.body.password === 'string' ? req.body.password : '';
  const key = loginKey(email);
  const failed = (reason, user) => audit(req, 'sign_in_failed', { actor: null, target: user ? personTarget(user) : null, details: `${key} (${reason})` });
  const ip = req.ip;
  if (ipBlocked(ip) || (loginInflight.get(ip) || 0) >= LOGIN_INFLIGHT_MAX) { failed('too many attempts from this address'); return bad(res, 'Too many sign-in attempts. Try again in 15 minutes.', 429); }
  loginInflight.set(ip, (loginInflight.get(ip) || 0) + 1);
  try { return await serialPerKey(key, () => loginAttempt(req, res, { email, password, key, failed })); }
  finally { const left = (loginInflight.get(ip) || 1) - 1; if (left) loginInflight.set(ip, left); else loginInflight.delete(ip); }
}));
// The checks of one sign-in attempt (run one at a time per account, see serialPerKey).
async function loginAttempt(req, res, { email, password, key, failed }) {
  if (isLocked(key)) { failed('account locked'); return bad(res, LOCKED_MSG, 429); }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.active || !(await passwords.compare(password, user.password_hash))) {
    failed(!user ? 'unknown email' : !user.active ? 'account deactivated' : 'wrong password', user);
    ipNoteFailure(req.ip);
    if (recordLoginFailure(key)) {
      console.log(`[login] account locked for ${LOCK_MINUTES} minutes after ${LOCK_FAILS} failed sign-ins`);
      audit(req, 'account_locked', { actor: null, target: user ? personTarget(user) : null, details: `${key}: ${LOCK_FAILS} failed sign-ins within ${LOCK_MINUTES} minutes; locked for ${LOCK_MINUTES} minutes` });
      return bad(res, LOCKED_MSG, 429);
    }
    return bad(res, 'Email or password is incorrect.', 401);
  }
  // Two-step verification on: the password was right, now the code (POST /api/login/code with this ticket).
  // Failures there count towards the same lockout, so they're only cleared once the code is right.
  if (user.totp_enabled_at) {
    const ticket = crypto.randomBytes(32).toString('base64url');
    db.prepare(`DELETE FROM login_challenges WHERE expires_at < datetime('now')`).run();
    db.prepare(`INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES (?,?,datetime('now','+5 minutes'))`).run(hashToken(ticket), user.id);
    return res.json({ need_code: true, ticket });
  }
  // Admins and managers without it: signed in, but the session can only set it up (auth()).
  const setup = needsTwoStep(user);
  audit(req, 'sign_in', { actor: user, target: personTarget(user), details: setup ? 'password only; asked to set up two-step verification' : '' });
  startSession(req, res, user, key, setup);
}
function startSession(req, res, user, key, setup) {
  loginAttempts.delete(req.ip);
  clearLoginFailures(key);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token,user_id,expires_at,last_active_at,needs_2fa_setup) VALUES (?,?,datetime('now', ?),datetime('now'),?)`).run(token, user.id, `+${SESSION_DAYS} days`, setup ? 1 : 0);
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE, maxAge: SESSION_DAYS * 864e5 });
  res.json({ user: publicUser(user), upload_max_mb: MAX_FILE_MB, csrf_token: csrfFor(token), must_setup_2fa: !!setup });
}
// Second step: the 6-digit code from the app, or a recovery code. 5 tries per ticket (5 minutes); every wrong code also
// counts towards the account lockout and the per-IP limit.
const CODE_WRONG = 'That code isn’t right. Enter the newest code from your authenticator app, or a recovery code.';
app.post('/api/login/code', (req, res) => {
  const ch = db.prepare(`SELECT c.token_hash, c.attempts, u.* FROM login_challenges c JOIN users u ON u.id = c.user_id
    WHERE c.token_hash = ? AND c.expires_at > datetime('now')`).get(hashToken(String(req.body.ticket || '')));
  const expired = 'This sign-in has expired. Enter your password again.';
  if (!ch) return bad(res, expired, 410);
  const { token_hash, attempts, ...user } = ch, key = loginKey(user.email);
  const failed = reason => audit(req, 'sign_in_failed', { actor: null, target: personTarget(user), details: `${key} (${reason})` });
  if (rateLimited(req.ip)) { failed('too many attempts from this address'); return bad(res, 'Too many sign-in attempts. Try again in 15 minutes.', 429); }
  if (isLocked(key)) { failed('account locked'); return bad(res, LOCKED_MSG, 429); }
  if (!user.active || user.removed_at || !user.totp_enabled_at) { db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(token_hash); return bad(res, expired, 410); }
  const how = useSecondFactor(user, req.body.code);
  if (!how) {
    failed('wrong two-step code');
    if (attempts + 1 >= 5) db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(token_hash);
    else db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = ?').run(token_hash);
    if (recordLoginFailure(key)) {
      audit(req, 'account_locked', { actor: null, target: personTarget(user), details: `${key}: ${LOCK_FAILS} failed sign-ins within ${LOCK_MINUTES} minutes; locked for ${LOCK_MINUTES} minutes` });
      return bad(res, LOCKED_MSG, 429);
    }
    return attempts + 1 >= 5 ? bad(res, 'Too many wrong codes. Enter your password again.', 410) : bad(res, CODE_WRONG, 401);
  }
  db.prepare('DELETE FROM login_challenges WHERE token_hash = ?').run(token_hash);
  const left = how === 'recovery' ? recoveryLeft(user.id) : null;
  audit(req, 'sign_in', { actor: user, target: personTarget(user), details: how === 'recovery' ? `with a recovery code (${left} left)` : 'with a two-step code' });
  startSession(req, res, user, key, false);
});

// ---------- password rules ----------
// At least 10 characters; not one of the 1000 most common passwords (common-passwords.txt: the top 1000 of the SecLists
// "10k most common" list, plus the 51 entries of 10+ characters from the rest of it, since the length rule already
// stops every top-1000 one), nor such a password with digits/symbols added, repeated or reversed in order
// ("password123!", "dragondragon", "2024monkey"); and not containing the person's email name. Checked wherever a
// password is set: change password, set-password links (welcome and forgot password), and passwords set by a manager.
// Existing passwords keep working (only new passwords are checked).
const COMMON_PASSWORDS = new Set(fs.readFileSync(path.join(__dirname, 'common-passwords.txt'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
function passwordProblem(pw, email) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password must be at most 200 characters.';
  const low = pw.toLowerCase();
  const core = low.replace(/^[^a-z]+|[^a-z]+$/g, ''); // without leading/trailing digits and symbols
  const half = low.length % 2 === 0 && low.slice(0, low.length / 2) === low.slice(low.length / 2) ? low.slice(0, low.length / 2) : null;
  if (COMMON_PASSWORDS.has(low) || (core.length >= 4 && COMMON_PASSWORDS.has(core)) || (half && COMMON_PASSWORDS.has(half)) || /^(.)\1+$/.test(low))
    return 'This password is too common. Choose a less predictable one.';
  const name = String(email || '').toLowerCase().split('@')[0].split('+')[0];
  if (name.length >= 3 && low.includes(name)) return 'The password can’t contain your email name.';
  for (const part of name.split(/[._-]+/)) if (part.length >= 4 && low.includes(part)) return 'The password can’t contain your email name.';
  return null;
}

app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid', { httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user), upload_max_mb: MAX_FILE_MB, csrf_token: csrfFor(req.cookies.sid),
  must_setup_2fa: needsTwoStep(req.user) && !req.user.totp_enabled_at && !!db.prepare('SELECT needs_2fa_setup FROM sessions WHERE token = ?').get(req.cookies.sid)?.needs_2fa_setup }));

// Account page: how many other sessions (browsers, the desktop app) are signed in, and "Sign out all other devices".
const otherSessions = req => db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND token != ? AND expires_at > datetime('now')
  AND (last_active_at IS NULL OR last_active_at >= datetime('now', ?))`).get(req.user.id, req.cookies.sid, `-${IDLE_HOURS} hours`).n;
app.get('/api/me/sessions', auth, (req, res) => res.json({ others: otherSessions(req) }));
app.post('/api/me/sessions/sign-out-others', auth, (req, res) => {
  const n = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.cookies.sid).changes;
  audit(req, 'signed_out_other_devices', { target: personTarget(req.user), details: `${n} other session${n === 1 ? '' : 's'} ended` });
  res.json({ ok: true, signed_out: n });
});

app.post('/api/me/password', auth, ah(async (req, res) => {
  const { current, next: nextPw } = req.body;
  if (!(await passwords.compare(String(current || ''), req.user.password_hash))) return bad(res, 'Current password is incorrect.');
  const problem = passwordProblem(nextPw, req.user.email);
  if (problem) return bad(res, problem);
  const newHash = await passwords.hash(nextPw);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.cookies.sid);
  audit(req, 'password_changed', { target: personTarget(req.user), details: 'changed on the Account page; other sessions ended' });
  res.json({ ok: true });
}));

// ---------- two-step verification (Security A2) ----------
// TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 seconds, one step either side for clock drift), any authenticator app.
// Optional for everyone; required for admins and managers, who are asked to set it up at their next sign-in (their
// session can then only reach the setup, see auth()). The secret is stored encrypted with a key derived from
// master.key; the 10 one-time recovery codes only as SHA-256. A code (or step) works once (totp_last_step).
const TWO_STEP_KEY = keys.derive(MASTER_KEY, 'totp secrets');
const needsTwoStep = u => isBoss(u);
function sealSecret(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', TWO_STEP_KEY, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), ct.toString('base64'), c.getAuthTag().toString('base64')].join('.');
}
function openSecret(sealed) {
  const [v, iv, ct, tag] = String(sealed || '').split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', TWO_STEP_KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32 = buf => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const unbase32 = s => { let bits = ''; for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); bits += i.toString(2).padStart(5, '0'); } return Buffer.from((bits.match(/.{8}/g) || []).map(b => parseInt(b, 2))); };
function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// The matching step (now, or one step before/after), or null. Steps up to lastStep are refused (each code works once).
function totpMatch(secret, code, lastStep) {
  const now = Math.floor(Date.now() / 30e3), want = Buffer.from(String(code));
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    const got = Buffer.from(totpAt(secret, step));
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return step;
  }
  return null;
}
// QR code as an SVG path (no text from the user inside; the page puts it in as is).
function qrSvg(text) {
  const qr = require('qrcode-generator')(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(); let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" width="200" height="200" shape-rendering="crispEdges" role="img" aria-label="QR code for your authenticator app"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const RECOVERY_COUNT = 10;
const normRecovery = c => String(c || '').toLowerCase().replace(/[^0-9a-z]/g, '');
function newRecoveryCodes(userId) {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => { const h = crypto.randomBytes(5).toString('hex'); return h.slice(0, 5) + '-' + h.slice(5); });
  db.transaction(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?,?)');
    for (const c of codes) ins.run(userId, hashToken(normRecovery(c)));
  })();
  return codes;
}
const recoveryLeft = userId => db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).n;
// Checks a 6-digit code or a recovery code for this person and uses it up. Returns 'code', 'recovery' or null.
function useSecondFactor(user, input) {
  const raw = String(input || '').trim();
  if (/^\d{6}$/.test(raw.replace(/\s/g, ''))) {
    let secret; try { secret = openSecret(user.totp_secret); } catch (e) { return null; }
    const step = totpMatch(secret, raw.replace(/\s/g, ''), user.totp_last_step);
    if (step === null) return null;
    // Only if no one used this step in the meantime (two sign-ins racing with the same code).
    return db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)').run(step, user.id, step).changes ? 'code' : null;
  }
  const norm = normRecovery(raw);
  if (norm.length !== 10) return null;
  return db.prepare(`UPDATE recovery_codes SET used_at = datetime('now') WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`).run(user.id, hashToken(norm)).changes ? 'recovery' : null;
}
const twoStepState = u => ({ enabled: !!u.totp_enabled_at, required: needsTwoStep(u), recovery_left: u.totp_enabled_at ? recoveryLeft(u.id) : 0 });

app.get('/api/me/2fa', auth, (req, res) => res.json(twoStepState(req.user)));
// Start (or restart) setting up: a new secret, kept as "pending" until a code from the app confirms it.
app.post('/api/me/2fa/setup', auth, (req, res) => {
  if (req.user.totp_enabled_at) return bad(res, 'Two-step verification is already on.', 409);
  const secret = base32(crypto.randomBytes(20));
  db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(sealSecret(secret), req.user.id);
  const uri = `otpauth://totp/${encodeURIComponent('TaskDesk:' + req.user.email)}?secret=${secret}&issuer=TaskDesk&algorithm=SHA1&digits=6&period=30`;
  res.json({ secret: secret.match(/.{1,4}/g).join(' '), qr_svg: qrSvg(uri) });
});
// Confirm with a code from the app: turns it on, returns the 10 recovery codes (shown once), and frees a setup-only session.
app.post('/api/me/2fa/enable', auth, (req, res) => {
  if (req.user.totp_enabled_at) return bad(res, 'Two-step verification is already on.', 409);
  if (!req.user.totp_pending) return bad(res, 'Start the setup again.', 409);
  let secret; try { secret = openSecret(req.user.totp_pending); } catch (e) { return bad(res, 'Start the setup again.', 409); }
  const step = totpMatch(secret, String(req.body.code || '').replace(/\s/g, ''), null);
  if (step === null) return bad(res, 'That code isn’t right. Check the time on your phone and enter the newest code.');
  db.transaction(() => {
    db.prepare(`UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = datetime('now'), totp_last_step = ? WHERE id = ?`).run(step, req.user.id);
    db.prepare('UPDATE sessions SET needs_2fa_setup = 0 WHERE user_id = ?').run(req.user.id);
  })();
  const codes = newRecoveryCodes(req.user.id);
  audit(req, '2fa_enabled', { target: personTarget(req.user), details: `two-step verification turned on; ${RECOVERY_COUNT} recovery codes made` });
  res.json({ ok: true, recovery_codes: codes });
});
// New recovery codes (the old ones stop working). Needs the password.
app.post('/api/me/2fa/recovery-codes', auth, ah(async (req, res) => {
  if (!req.user.totp_enabled_at) return bad(res, 'Two-step verification is off.', 409);
  if (!(await passwords.compare(String(req.body.password || ''), req.user.password_hash))) return bad(res, 'Password is incorrect.');
  const codes = newRecoveryCodes(req.user.id);
  audit(req, '2fa_recovery_codes_renewed', { target: personTarget(req.user), details: `${RECOVERY_COUNT} new recovery codes; the old ones stop working` });
  res.json({ ok: true, recovery_codes: codes });
}));
// Turn it off (not for admins and managers, who must keep it). Needs the password.
app.post('/api/me/2fa/disable', auth, ah(async (req, res) => {
  if (needsTwoStep(req.user)) return bad(res, 'Admins and managers must keep two-step verification on.', 403);
  if (!req.user.totp_enabled_at) return bad(res, 'Two-step verification is already off.', 409);
  if (!(await passwords.compare(String(req.body.password || ''), req.user.password_hash))) return bad(res, 'Password is incorrect.');
  clearTwoStep(req.user.id);
  audit(req, '2fa_disabled', { target: personTarget(req.user), details: 'turned off on the Account page' });
  res.json({ ok: true });
}));
function clearTwoStep(userId) {
  db.transaction(() => {
    db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?').run(userId);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM login_challenges WHERE user_id = ?').run(userId);
  })();
}

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
  return mailer.tokenLink(token); // …/#token=<token>: in the fragment, never in a query string
}
// A token that can still be used (not used, not expired, person active and not removed), with its person.
function liveToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return db.prepare(`SELECT pt.id, pt.purpose, pt.user_id, u.name, u.email FROM password_tokens pt JOIN users u ON u.id = pt.user_id
    WHERE pt.token_hash = ? AND pt.used_at IS NULL AND pt.expires_at > datetime('now') AND u.active = 1 AND u.removed_at IS NULL`).get(hashToken(token));
}
function sendWelcome(user, by, onResult) {
  const url = issueToken(user, 'welcome', by && by.id);
  return mailer.queue(user.email, 'Welcome to TaskDesk', mailer.layout({
    heading: `Welcome to TaskDesk, ${user.name}`,
    lines: [`${by ? by.name : 'Your admin'} added you to TaskDesk, Hi-Focus's task and request tracker. Your sign-in email is ${user.email}.`,
      'Choose your password to get started. The link works once and expires in 48 hours.'],
    button: { label: 'Set your password', url },
    after: ['If the link has expired, ask your manager to resend it, or use "Forgot password?" on the sign-in page.']
  }), onResult);
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
  audit(req, 'password_reset_requested', { actor: null, target: user ? personTarget(user) : null, details: user ? (mailer.enabled() ? 'reset link emailed' : 'email is off; nothing sent') : `${email} (no active account)` });
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
// The token travels only in a POST body (never in a URL, so no access log, proxy log or WAF log can hold it).
app.post('/api/password/check', (req, res) => {
  if (overLimit('pwlink-ip:' + req.ip, 60, 15 * 60e3)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
  const t = liveToken(req.body && req.body.token);
  if (!t) return bad(res, DEAD_LINK, 410);
  res.json({ ok: true, purpose: t.purpose, name: t.name });
});
// Set the password with a link: single use; ends all of the person's sessions and cancels their other links.
app.post('/api/password/set', ah(async (req, res) => {
  if (overLimit('pwlink-ip:' + req.ip, 60, 15 * 60e3)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const t = liveToken(req.body.token);
  if (!t) return bad(res, DEAD_LINK, 410);
  const problem = passwordProblem(password, t.email);
  if (problem) return bad(res, problem);
  const newHash = await passwords.hash(password); // off the main thread; the link is only used up (single use) in the transaction below
  const ok = db.transaction(() => {
    if (!db.prepare(`UPDATE password_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`).run(t.id).changes) return false;
    db.prepare(`UPDATE password_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(t.user_id);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, t.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(t.user_id);
    clearLoginFailures(loginKey(t.email), true); // a new password lifts a lockout
    return true;
  })();
  if (!ok) return bad(res, DEAD_LINK, 410);
  console.log(`[password] ${t.purpose} link used by user ${t.user_id}; sessions ended`);
  audit(req, 'password_reset', { actor: null, target: { type: 'person', id: t.user_id, name: t.name }, details: `set with a ${t.purpose === 'welcome' ? 'welcome' : 'Forgot password'} link; all sessions ended` });
  res.json({ ok: true });
}));

// Email settings (admins): what is configured (never the password), the last error, and a test email to themself.
const emailStatus = () => ({ ...mailer.status(), welcome: welcomeStatus() }); // + the welcome emails still to go out (bulk import)
app.get('/api/email/status', auth, requireAdmin, (req, res) => res.json(emailStatus()));
app.post('/api/email/test', auth, requireAdmin, async (req, res) => {
  const error = await mailer.sendNow(req.user.email, 'TaskDesk test email', mailer.layout({
    heading: 'Email is working',
    lines: [`Hi ${req.user.name}, this is a test email from TaskDesk. If you can read it, TaskDesk can send email.`],
    button: { label: 'Open TaskDesk', url: mailer.link('') }
  }));
  res.json(error ? { ok: false, error, status: emailStatus() } : { ok: true, to: req.user.email, status: emailStatus() });
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
// Messages people see never mention the owner (the label is hidden in the app); server logs and account_events do.
const OWNER_MSG = 'This account can’t be changed.';
const PROTECTED_MSG = 'This account is protected. It can’t be removed, deactivated or given a lower role.';
const OWNER_SELF_MSG = 'This account can’t be removed, deactivated or given a lower role.';
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
  // All people (Scale), managers/admins: ?paged=1&q=&team=&role=&status=&limit=&offset= -> { users, total, total_all, more }.
  // status: active | inactive | removed | (empty = everyone who isn't removed). total_all = everyone in that status group.
  // Without paged=1 the whole list comes back as before: the pickers (task form, filters, team page) need all of it.
  if (isBoss(u) && req.query.paged === '1') {
    const status = String(req.query.status || ''), base = status === 'removed' ? 'removed_at IS NOT NULL' : 'removed_at IS NULL';
    const where = [base], params = [];
    if (status === 'active') where.push('active = 1'); else if (status === 'inactive') where.push('active = 0');
    teamFilter(req.query.team, 'team_id', where, params);
    if (ROLES.includes(req.query.role)) { where.push('role = ?'); params.push(req.query.role); }
    const text = str(req.query.q, 100);
    if (text) { where.push(`(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`); params.push(likeText(text), likeText(text)); }
    const { limit, offset } = pageOf(req, 50), W = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${W}`).get(...params).n;
    const total_all = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${base}`).get().n;
    const rows = db.prepare(`SELECT * FROM users WHERE ${W} ORDER BY active DESC, name, id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return res.json({ users: rows.map(r => u.role === 'admin' ? { ...publicUser(r), two_step: !!r.totp_enabled_at } : publicUser(r)), total, total_all, more: offset + rows.length < total });
  }
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
  // Admins also see who has two-step verification on (person form: "Reset two-step verification").
  res.json({ users: rows.map(r => u.role === 'admin' ? { ...publicUser(r), two_step: !!r.totp_enabled_at } : publicUser(r)) });
});

// Creates one person (the row, the audit entry, auto-lead, managed teams). The caller has already validated everything and
// calls syncTeamChats() afterwards (once, for a whole import). Used by POST /api/users and the bulk import.
function insertPerson(f, req) {
  const r = db.prepare('INSERT INTO users (name,email,password_hash,role,lead_id,team_id) VALUES (?,?,?,?,?,?)').run(f.name, f.email, f.hash, f.role, f.lead_id || null, f.team_id || null);
  audit(req, 'person_added', { target: { type: 'person', id: r.lastInsertRowid, name: f.name }, details: `${f.email}; role ${f.role}; team ${teamLabel(f.team_id)}${f.managedIds ? `; manages ${f.managedIds.map(teamLabel).join(', ')}` : ''}; ${f.how}` });
  const became_lead = autoLead(r.lastInsertRowid, req.user.id);
  if (f.managedIds) setManagedTeams(r.lastInsertRowid, f.managedIds, req.user.id);
  return { id: r.lastInsertRowid, became_lead };
}
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
  if (!welcome) { const problem = passwordProblem(password, email); if (problem) return bad(res, problem); }
  if (lead_id && !db.prepare(`SELECT 1 FROM users WHERE id = ? AND role IN ('lead','manager','admin')`).get(lead_id)) return bad(res, 'Choose a valid team lead.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'A user with this email already exists.');
  const made = insertPerson({ name, email, role, lead_id, team_id, hash: welcome ? UNUSABLE_HASH() : bcrypt.hashSync(password, 10), managedIds: managed.ids,
    how: welcome ? 'welcome email' : 'password set by ' + req.user.name }, req);
  const became_lead = made.became_lead;
  syncTeamChats();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(made.id);
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

// ---------- bulk import of people (Scale) ----------
// Admins and managers: Teams > All people > "Import from Excel/CSV". Two steps. preview reads the file (kept in memory,
// never stored, never virus-scanned because it is only parsed) and reports every row's problems without writing anything;
// commit receives the same rows, checks them all again (nothing from the browser is trusted), and in one transaction
// creates the missing teams (only if "Create missing teams" is ticked) and the people. Import only ever creates people:
// an email that already has an account is skipped, never edited. Every new person is put in welcome_queue, and the welcome
// emails go out gradually (see drainWelcome).
const importfile = require('./importfile');
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: importfile.MAX_BYTES, files: 1, fields: 4, parts: 6 } });
const IMPORT_ROLES = { employee: 'employee', lead: 'lead', 'team lead': 'lead', 'team manager': 'team_manager', manager: 'manager', 'company manager': 'manager' };
const IMPORT_ROLE_HELP = 'Use employee, lead, team_manager or manager.';
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const UNUSABLE_HASH = () => '!unset-' + crypto.randomBytes(16).toString('hex'); // not a bcrypt hash: no password matches it, until a link sets one

// The rows as they would be imported: { rows: [{ line, name, email, team, role, ok, problems, warnings, team_new }], new_teams }.
function planImport(rawRows, { createTeams }) {
  const accounts = new Map(), removedMail = new Set();
  for (const u of db.prepare('SELECT id, name, email, protected, removed_at, original_email FROM users').all()) {
    if (u.removed_at) { if (u.original_email) removedMail.add(u.original_email.toLowerCase()); } else accounts.set(u.email.toLowerCase(), u);
  }
  const teams = new Map(db.prepare('SELECT id, name FROM teams').all().map(t => [t.name.toLowerCase(), t]));
  const seen = new Map(), newTeams = new Map();
  const rows = rawRows.map((r, i) => {
    const o = { line: Number(r && r.line) || i + 2, name: str(r && r.name, 1000), email: str(r && r.email, 500), team: str(r && r.team, 1000), role: str(r && r.role, 200) };
    const problems = [], warnings = [];
    if (!o.name) problems.push('Name is missing.'); else if (o.name.length > 120) problems.push('Name is longer than 120 characters.');
    const low = o.email.toLowerCase();
    if (!o.email) problems.push('Email is missing.');
    else if (!EMAIL_SHAPE.test(o.email) || o.email.length > 200) problems.push(`“${o.email.slice(0, 60)}” isn’t a valid email address.`);
    else if (/@example\.com$/i.test(o.email)) problems.push('This is an example row from the template. Delete it or use a real email.');
    else {
      if (seen.has(low)) problems.push(`Same email as row ${seen.get(low)} of this file.`); else seen.set(low, o.line);
      const have = accounts.get(low);
      if (have) problems.push(have.protected || isOwner(have) ? 'This account can’t be changed by an import.' : `Already has an account (${have.name}).`);
      else if (removedMail.has(low)) warnings.push('This email belonged to a removed person. A new account is made.');
    }
    const roleKey = o.role.toLowerCase().replace(/[_\-\s]+/g, ' ').trim();
    if (!roleKey) { o.role = 'employee'; warnings.push('No role given: employee.'); }
    else if (roleKey === 'admin') problems.push('Admins can’t be imported. Add them one by one.');
    else if (IMPORT_ROLES[roleKey]) o.role = IMPORT_ROLES[roleKey];
    else problems.push(`Unknown role “${o.role.slice(0, 40)}”. ${IMPORT_ROLE_HELP}`);
    if (o.team) {
      if (o.team.length > 120) problems.push('Team name is longer than 120 characters.');
      else if (teams.has(o.team.toLowerCase())) { o.team = teams.get(o.team.toLowerCase()).name; o.team_id = teams.get(o.team.toLowerCase()).id; }
      else if (createTeams) { o.team_new = true; if (!newTeams.has(o.team.toLowerCase())) newTeams.set(o.team.toLowerCase(), o.team); else o.team = newTeams.get(o.team.toLowerCase()); }
      else problems.push(`Unknown team “${o.team.slice(0, 40)}”. Tick “Create missing teams”, or fix the name.`);
    }
    if (o.role === 'team_manager' && !o.team) problems.push('A team manager needs a team (the team they manage).');
    if (o.role === 'lead' && !o.team) warnings.push('A lead without a team doesn’t lead anyone yet.');
    return { ...o, ok: !problems.length, problems, warnings };
  });
  // Only teams that an importable row needs are created.
  const need = new Map();
  for (const r of rows) if (r.ok && r.team_new) need.set(r.team.toLowerCase(), r.team);
  return { rows, new_teams: [...need.values()] };
}
const importCounts = rows => ({ total: rows.length, ok: rows.filter(r => r.ok).length, problems: rows.filter(r => !r.ok).length, warnings: rows.filter(r => r.ok && r.warnings.length).length });

app.get('/api/users/import/template', auth, requireBoss, (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.attachment('taskdesk-people-template.csv');
  res.send('﻿name,email,team,role\r\nAsha Rao,asha.rao@example.com,R&D,employee\r\nVikram Shah,vikram.shah@example.com,Testing,lead\r\n');
});
app.post('/api/users/import/preview', auth, requireBoss, (req, res) => {
  importUpload.single('file')(req, res, err => {
    if (err) return bad(res, err.code === 'LIMIT_FILE_SIZE' ? `The file is too big (the most is ${importfile.MAX_BYTES / 1024 / 1024} MB).` : 'The upload failed. Try again.');
    if (!req.file) return bad(res, 'Choose an Excel (.xlsx) or CSV file.');
    let parsed;
    try { parsed = importfile.parsePeople(req.file.buffer, req.file.originalname); }
    catch (e) { return e.userMessage ? bad(res, e.message) : (console.error('[import] could not read the file:', e.message), bad(res, 'This file couldn’t be read. Save it as .xlsx or CSV and try again.')); }
    const plan = planImport(parsed.rows, { createTeams: req.body.create_missing_teams === '1' || req.body.create_missing_teams === 'true' });
    res.json({ file_name: (req.file.originalname || '').slice(0, 200), email_enabled: mailer.enabled(), columns: parsed.columns, counts: importCounts(plan.rows), new_teams: plan.new_teams, rows: plan.rows });
  });
});
app.post('/api/users/import/commit', auth, requireBoss, (req, res) => {
  if (!mailer.enabled()) return bad(res, 'Email isn’t set up, so welcome emails can’t be sent. Set it up first.');
  const raw = Array.isArray(req.body.rows) ? req.body.rows : null;
  if (!raw || !raw.length) return bad(res, 'There is nothing to import.');
  if (raw.length > importfile.MAX_ROWS) return bad(res, `Too many rows (the most is ${importfile.MAX_ROWS} people per import).`);
  const plan = planImport(raw, { createTeams: !!req.body.create_missing_teams });
  const good = plan.rows.filter(r => r.ok);
  if (!good.length) return bad(res, 'No row can be imported. Fix the problems and preview again.');
  const fileName = str(req.body.file_name, 200);
  const made = db.transaction(() => {
    const teamIds = new Map();
    for (const name of plan.new_teams) {
      const t = db.prepare('INSERT INTO teams (name) VALUES (?)').run(name).lastInsertRowid;
      teamIds.set(name.toLowerCase(), t);
      audit(req, 'team_created', { target: { type: 'team', id: t, name }, details: `created by the import of ${fileName || 'a file'}` });
    }
    const queue = db.prepare('INSERT INTO welcome_queue (user_id, queued_by) VALUES (?,?)');
    const ids = [];
    for (const r of good) {
      const team_id = r.team ? (r.team_id || teamIds.get(r.team.toLowerCase())) : null;
      const p = insertPerson({ name: r.name, email: r.email, role: r.role, team_id, hash: UNUSABLE_HASH(), managedIds: r.role === 'team_manager' ? [team_id] : null,
        how: `imported from ${fileName || 'a file'}; welcome email queued` }, req);
      queue.run(p.id, req.user.id);
      ids.push(p.id);
    }
    return { ids, teams: plan.new_teams.length };
  })();
  syncTeamChats(); // once for the whole import
  const skipped = plan.rows.length - good.length;
  audit(req, 'people_imported', { details: `${fileName || 'file'}: ${made.ids.length} people created, ${skipped} rows skipped, ${made.teams} teams created; ${made.ids.length} welcome emails queued` });
  console.log(`[import] ${req.user.name} imported ${made.ids.length} people (${skipped} rows skipped, ${made.teams} teams created)`);
  setImmediate(drainWelcome);
  res.json({ created: made.ids.length, skipped, teams_created: made.teams, eta: welcomeEta(made.ids.length) });
});

// Welcome emails for imported people go out gradually, so the mail provider's limits are respected (EMAIL_PER_MINUTE
// paces every email; EMAIL_WELCOME_PER_DAY, default 400, 0 = no cap, limits welcome emails in any 24 hours). A few at a
// time are handed to the mail queue; the set-password link is made at that moment (its 48 hours start when it is sent).
// The list lives in the database, so a restart loses nothing. After a failed send (3 tries) it waits 30 minutes and tries
// again, up to 5 times; a provider "limit reached" answer pauses all email for an hour (mailer.js).
const WELCOME_PER_DAY = (n => Number.isFinite(n) && n >= 0 ? Math.round(n) : 400)(process.env.EMAIL_WELCOME_PER_DAY === undefined || process.env.EMAIL_WELCOME_PER_DAY === '' ? NaN : Number(process.env.EMAIL_WELCOME_PER_DAY));
const WELCOME_INFLIGHT = 3, WELCOME_TRIES = 5;
const WELCOME_RETRY_SQL = process.env.EMAIL_DRY_RUN === '1' && process.env.EMAIL_TEST_SPEED === '1' ? '+2 seconds' : '+30 minutes'; // (the test switch is in mailer.js)
const WQ_OPEN = 'sent_at IS NULL AND failed_at IS NULL';
function welcomeEta(n) {
  const perMin = mailer.status().per_minute;
  return WELCOME_PER_DAY && n > WELCOME_PER_DAY ? `about ${Math.ceil(n / WELCOME_PER_DAY)} days (at most ${WELCOME_PER_DAY} a day)` : `about ${Math.max(1, Math.ceil(n / perMin))} ${Math.max(1, Math.ceil(n / perMin)) === 1 ? 'minute' : 'minutes'} (${perMin} a minute)`;
}
function welcomeStatus() {
  const c = sql => db.prepare(sql).get().n;
  return { waiting: c(`SELECT COUNT(*) n FROM welcome_queue WHERE ${WQ_OPEN}`), sent_24h: c(`SELECT COUNT(*) n FROM welcome_queue WHERE sent_at > datetime('now','-24 hours')`),
    failed: c('SELECT COUNT(*) n FROM welcome_queue WHERE failed_at IS NOT NULL'), per_day: WELCOME_PER_DAY };
}
let draining = false;
function drainWelcome() {
  if (draining || !mailer.enabled()) return;
  draining = true;
  try {
    if (mailer.status().paused_until) return;
    const inflight = db.prepare(`SELECT COUNT(*) n FROM welcome_queue WHERE handed_at IS NOT NULL AND ${WQ_OPEN}`).get().n;
    let budget = WELCOME_INFLIGHT - inflight;
    if (WELCOME_PER_DAY) budget = Math.min(budget, WELCOME_PER_DAY - db.prepare(`SELECT COUNT(*) n FROM welcome_queue WHERE sent_at > datetime('now','-24 hours')`).get().n - inflight);
    if (budget <= 0) return;
    const rows = db.prepare(`SELECT w.user_id, w.queued_by FROM welcome_queue w WHERE w.handed_at IS NULL AND ${WQ_OPEN} AND w.next_at <= datetime('now')
      ORDER BY w.queued_at, w.user_id LIMIT ?`).all(budget);
    for (const w of rows) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(w.user_id);
      // Gone, deactivated, or they already have a password (set another way): nothing to send.
      if (!user || !user.active || user.removed_at || !String(user.password_hash).startsWith('!')) { db.prepare('DELETE FROM welcome_queue WHERE user_id = ?').run(w.user_id); continue; }
      db.prepare(`UPDATE welcome_queue SET handed_at = datetime('now') WHERE user_id = ?`).run(w.user_id);
      const by = w.queued_by ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(w.queued_by) : null;
      sendWelcome(user, by, result => {
        setImmediate(drainWelcome); // one slot is free again: refill at once, so the pace is the mail pace, not the 10 s timer
        if (result.ok) return db.prepare(`UPDATE welcome_queue SET sent_at = datetime('now'), last_error = NULL WHERE user_id = ?`).run(w.user_id);
        const tries = db.prepare('SELECT attempts FROM welcome_queue WHERE user_id = ?').get(w.user_id);
        if (!tries) return;
        if (tries.attempts + 1 >= WELCOME_TRIES) db.prepare(`UPDATE welcome_queue SET failed_at = datetime('now'), attempts = attempts + 1, last_error = ? WHERE user_id = ?`).run(String(result.error).slice(0, 300), w.user_id);
        else db.prepare(`UPDATE welcome_queue SET handed_at = NULL, attempts = attempts + 1, next_at = datetime('now','${WELCOME_RETRY_SQL}'), last_error = ? WHERE user_id = ?`).run(String(result.error).slice(0, 300), w.user_id);
      });
    }
  } catch (e) { console.error('[welcome] drain failed:', e.message); }
  finally { draining = false; }
}
// A restart loses the mail queue (it is in memory): anything handed over but not sent goes back in line.
db.prepare(`UPDATE welcome_queue SET handed_at = NULL WHERE handed_at IS NOT NULL AND ${WQ_OPEN}`).run();
setInterval(drainWelcome, 10e3).unref();
setTimeout(drainWelcome, 3e3).unref();

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
  audit(req, 'welcome_resent', { target: personTarget(target), details: 'new “Set your password” link emailed; earlier links stop working' });
  res.json({ ok: true, email: target.email });
});

// Reset someone's two-step verification (lost phone and no recovery codes): admins only, never their own (Account
// page) and never the owner's. Ends the person's sessions; admins and managers are asked to set it up again at sign-in.
app.delete('/api/users/:id/2fa', auth, ownerFirst('reset two-step verification'), requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return bad(res, 'User not found.', 404);
  if (target.id === req.user.id) return bad(res, 'Use your Account page to change your own two-step verification.', 400);
  if (!target.totp_enabled_at && !target.totp_pending) return bad(res, 'Two-step verification is already off for this person.', 409);
  clearTwoStep(target.id);
  const ended = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id).changes;
  audit(req, '2fa_reset', { target: personTarget(target), details: `two-step verification reset by ${req.user.name}; ${ended} session${ended === 1 ? '' : 's'} ended` });
  res.json({ ok: true });
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
      return bad(res, 'Role and email are fixed for this account.', 403); // it must stay equal to OWNER_EMAIL (see scripts/restore.md)
    if (req.body.protected !== undefined && !req.body.protected) return bad(res, 'This account is always protected.', 403);
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
    return bad(res, 'You can’t turn protection on or off.', 403);
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
    const problem = passwordProblem(String(req.body.password), f.email || target.email);
    if (problem) return bad(res, problem);
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
  // Audit: one entry per kind of change, old → new.
  const tgt = personTarget({ id: target.id, name: f.name || target.name });
  if (f.role !== undefined && f.role !== target.role) audit(req, 'role_changed', { target: tgt, details: `${target.role} → ${f.role}` });
  if (f.team_id !== undefined && (f.team_id || null) !== (target.team_id || null)) audit(req, 'team_changed', { target: tgt, details: `${teamLabel(target.team_id)} → ${teamLabel(f.team_id)}` });
  if (f.lead_id !== undefined && (f.lead_id || null) !== (target.lead_id || null)) audit(req, 'lead_changed', { target: tgt, details: `lead ${personLabel(target.lead_id)} → ${personLabel(f.lead_id)}` });
  if (managed.ids) audit(req, 'managed_teams_changed', { target: tgt, details: `manages ${managed.ids.map(teamLabel).join(', ') || 'no team'}` });
  if (f.active !== undefined && f.active !== target.active) audit(req, f.active ? 'account_activated' : 'account_deactivated', { target: tgt, details: f.active ? '' : 'sessions ended' });
  if (f.protected !== undefined) audit(req, 'protection_changed', { target: tgt, details: f.protected ? 'protection on' : 'protection off' });
  if (f.password_hash) audit(req, 'password_set_by_manager', { target: tgt, details: 'all sessions ended' });
  if ((f.name !== undefined && f.name !== target.name) || (f.email !== undefined && f.email !== target.email))
    audit(req, 'person_edited', { target: tgt, details: [f.name !== undefined && f.name !== target.name ? `name ${target.name} → ${f.name}` : '', f.email !== undefined && f.email !== target.email ? `email ${target.email} → ${f.email}` : ''].filter(Boolean).join('; ') });
  if (became_lead) audit(req, 'lead_changed', { target: tgt, details: `now a lead of ${became_lead.team_name}` });
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)), became_lead });
});

// A person's account activity: managers/admins and the person themself. Newest first, last 100.
app.get('/api/users/:id/events', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!isBoss(req.user) && req.user.id !== id) return bad(res, 'Not allowed.', 403);
  // Owner records stay in the table (and the server log) but aren't shown: transfers never, refusals only to the owner.
  const hide = isOwner(req.user) ? `AND e.action != 'owner_transfer'` : `AND e.action NOT IN ('owner_transfer','owner_refused')`;
  res.json({ events: db.prepare(`SELECT e.id, e.action, e.detail, e.created_at, a.name AS actor_name FROM account_events e
    LEFT JOIN users a ON a.id = e.actor_id WHERE e.user_id = ? ${hide} ORDER BY e.id DESC LIMIT 100`).all(id) });
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
  audit(req, 'person_removed', { target: personTarget(t), details: r.total ? `${t.email}; account kept for History (marked removed)` : `${t.email}; account deleted (no records)` });
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
  audit(req, 'person_restored', { target: { type: 'person', id: t.id, name: t.name.replace(/ \(removed\)$/, '') }, details: t.original_email });
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
// Paging (Scale): lists take ?limit= and ?offset= and answer with the page plus the totals the page shows, so nothing is
// counted from the rows that happen to be loaded. limit is capped at 200.
const pageOf = (req, def = 100) => ({ limit: Math.min(Math.max(parseInt(req.query.limit) || def, 1), 200), offset: Math.min(Math.max(parseInt(req.query.offset) || 0, 0), 1e6) });
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
const TASK_FROM = TASK_SELECT.slice(TASK_SELECT.indexOf('FROM tasks t'));
const OVERDUE_SQL = `t.status != 'completed' AND t.deadline IS NOT NULL AND t.deadline < date('now','localtime')`;
const TASK_STATS = `COUNT(*) AS total, COALESCE(SUM(t.status != 'completed'), 0) AS open, COALESCE(SUM(${OVERDUE_SQL}), 0) AS overdue`;
// The tasks list, in pages (Scale). All of these only narrow what taskScope allows:
//   ?limit=&offset=            a page of the list (default 100, at most 200) -> { tasks, total, more, stats }
//   ?group=team&per_group=30   the "All teams" view: the first rows of every team + each team's totals -> { groups, stats }
//   ?view=board&per_column=40  the board: the first rows of every status column + each column's total -> { columns, stats }
//   ?col=<status>              only that status (the board's "Load more"); sort=completed = newest completed first
// stats = { total, open, overdue } for everything the filters match (not just the rows sent).
app.get('/api/tasks', auth, (req, res) => {
  const s = taskScope(req.user);
  const where = [s.sql], params = [...s.params];
  const { status, project, assignee, mine } = req.query;
  if (status === 'overdue') where.push(OVERDUE_SQL);
  else if (status === 'open') where.push(`t.status != 'completed'`);
  else if (STATUSES.includes(status)) { where.push('t.status = ?'); params.push(status); }
  if (STATUSES.includes(req.query.col)) { where.push('t.status = ?'); params.push(req.query.col); }
  if (project) { where.push('t.project_id = ?'); params.push(Number(project)); }
  if (assignee) { where.push('t.assignee_id = ?'); params.push(Number(assignee)); }
  if (mine === 'assigned_by_me') { where.push('t.assigned_by = ?'); params.push(req.user.id); }
  // Team tabs, search, quick filters and sort (all optional; they only narrow the list above).
  teamFilter(req.query.team, 'a.team_id', where, params);
  const q = str(req.query.q, 100);
  if (q) { where.push(`(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')`); params.push(likeText(q), likeText(q)); }
  if (req.query.due === 'overdue') where.push(OVERDUE_SQL);
  else if (req.query.due === 'week') where.push(`t.status != 'completed' AND t.deadline BETWEEN date('now','localtime') AND date('now','localtime','+6 days')`);
  if (req.query.priority === 'high') where.push(`t.priority IN ('urgent','high')`);
  else if (PRIORITIES.includes(req.query.priority)) { where.push('t.priority = ?'); params.push(req.query.priority); }
  if (req.query.review === 'mine') { const rs = reviewScope(req.user); where.push(`(${rs.sql})`); params.push(...rs.params); }
  const PRIO = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;
  const order = req.query.sort === 'priority' ? `t.status = 'completed', ${PRIO}, t.deadline IS NULL, t.deadline, t.id DESC`
    : req.query.sort === 'newest' ? 't.id DESC'
    : req.query.sort === 'completed' ? 't.completed_at DESC, t.id DESC'
    : `t.status = 'completed', t.deadline IS NULL, t.deadline, ${PRIO}, t.id DESC`; // "deadline" (the default)
  const W = where.join(' AND ');
  const stats = db.prepare(`SELECT ${TASK_STATS} ${TASK_FROM} WHERE ${W}`).get(...params);
  if (req.query.group === 'team') { // "All teams": the first rows of every team
    const per = Math.min(Math.max(parseInt(req.query.per_group) || 30, 1), 100);
    const rows = db.prepare(`SELECT * FROM (${TASK_SELECT.replace('SELECT t.*,', `SELECT t.*, ROW_NUMBER() OVER (PARTITION BY a.team_id ORDER BY ${order}) AS rn,`)} WHERE ${W})
      WHERE rn <= ? ORDER BY team_id IS NULL, team_id, rn`).all(...params, per);
    const groups = db.prepare(`SELECT a.team_id, tm.name AS team_name, ${TASK_STATS} ${TASK_FROM} WHERE ${W} GROUP BY a.team_id`).all(...params)
      .map(g => ({ ...g, tasks: [] }));
    const by = new Map(groups.map(g => [g.team_id, g]));
    for (const r of rows) { delete r.rn; by.get(r.team_id).tasks.push(r); }
    return res.json({ groups, stats });
  }
  if (req.query.view === 'board') { // one column per status
    const per = Math.min(Math.max(parseInt(req.query.per_column) || 40, 1), 100), columns = {};
    for (const st of STATUSES) {
      const total = db.prepare(`SELECT COUNT(*) AS n ${TASK_FROM} WHERE ${W} AND t.status = ?`).get(...params, st).n;
      columns[st] = { total, tasks: total ? db.prepare(`${TASK_SELECT} WHERE ${W} AND t.status = ? ORDER BY ${st === 'completed' ? 't.completed_at DESC, t.id DESC' : order} LIMIT ?`).all(...params, st, per) : [] };
    }
    return res.json({ columns, stats });
  }
  const { limit, offset } = pageOf(req);
  const rows = db.prepare(`${TASK_SELECT} WHERE ${W} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ tasks: rows, total: stats.total, more: offset + rows.length < stats.total, stats });
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
        locked: isOwner(m), protected: !!m.protected };
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
  audit(req, 'team_deleted', { target: { type: 'team', id: team.id, name: team.name }, details: 'its members now have no team' });
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
  if (t.user.team_id !== t.team.id) audit(req, 'team_changed', { target: personTarget(t.user), details: `${teamLabel(t.user.team_id)} → ${t.team.name}${became_lead ? ` (now a lead of ${t.team.name})` : ''}` });
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
  const before = leadsOf(team.id).map(l => l.name);
  const err = setTeamLeads(team.id, ids, req.user.id);
  if (err) return bad(res, err);
  syncTeamChats();
  const after = leadsOf(team.id).map(l => l.name);
  if (before.join('|') !== after.join('|')) audit(req, 'team_leads_changed', { target: { type: 'team', id: team.id, name: team.name }, details: `${before.join(', ') || 'none'} → ${after.join(', ') || 'none'}` });
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
  audit(req, 'team_managers_changed', { target: { type: 'team', id: team.id, name: team.name }, details: managersOf(team.id).map(m => m.name).join(', ') || 'none' });
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
  const moved = db.prepare('UPDATE users SET team_id = NULL WHERE id = ? AND team_id = ?').run(t.user.id, t.team.id).changes;
  syncTeamChats();
  if (moved) audit(req, 'team_changed', { target: personTarget(t.user), details: `${t.team.name} → no team` });
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

const REQ_ORDER = `CASE r.status WHEN 'needs_team' THEN 0 WHEN 'open' THEN 1 WHEN 'assigned' THEN 2 WHEN 'delivered' THEN 3 ELSE 4 END, r.needed_by IS NULL, r.needed_by, r.id DESC`;
const reqRowOut = r => ({ id: r.id, title: r.title, requested_by: r.requested_by, requested_by_name: r.requested_by_name,
  target_team_id: r.target_team_id, team_name: r.team_name, requester_team_id: r.requester_team_id, requester_team_name: r.requester_team_name,
  needed_by: r.needed_by, status: r.status, assignee_name: r.assignee_name, asked_person_name: r.asked_person_name, created_at: r.created_at });
// The requests board, in pages (Scale): ?limit=&offset= -> { requests, total, more, stats }; ?group=team&per_group=30 (the
// "All teams" view, grouped by the team a request was sent to) -> { groups, stats }. stats = { total, waiting } for
// everything the filters match; waiting = needs a team or open, as the group headers say "waiting for someone".
app.get('/api/requests', auth, (req, res) => {
  const scope = requestScope(req.user);
  const where = [scope.sql], params = [...scope.params];
  teamFilter(req.query.team, 'r.target_team_id', where, params);        // "Incoming" (and the old team filter)
  teamFilter(req.query.from_team, 'rb.team_id', where, params);         // "Sent": the requester's team
  const q = str(req.query.q, 100);
  if (q) { where.push(`(r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\')`); params.push(likeText(q), likeText(q)); }
  if (req.query.status === 'active') where.push(`r.status IN ('needs_team','open','assigned','delivered')`);
  else if (REQ_STATUSES.includes(req.query.status)) { where.push('r.status = ?'); params.push(req.query.status); }
  const W = where.join(' AND '), WAITING = `r.status IN ('needs_team','open')`;
  const FROM = 'FROM requests r JOIN users rb ON rb.id = r.requested_by';
  const stats = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(${WAITING}), 0) AS waiting ${FROM} WHERE ${W}`).get(...params);
  if (req.query.group === 'team') {
    const per = Math.min(Math.max(parseInt(req.query.per_group) || 30, 1), 100);
    const rows = db.prepare(`SELECT * FROM (${REQ_SELECT.replace('SELECT r.*,', `SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.target_team_id ORDER BY ${REQ_ORDER}) AS rn,`)} WHERE ${W})
      WHERE rn <= ? ORDER BY target_team_id IS NULL, target_team_id, rn`).all(...params, per);
    const groups = db.prepare(`SELECT r.target_team_id AS team_id, tm.name AS team_name, COUNT(*) AS total, COALESCE(SUM(${WAITING}), 0) AS waiting ${FROM}
      LEFT JOIN teams tm ON tm.id = r.target_team_id WHERE ${W} GROUP BY r.target_team_id`).all(...params)
      .map(g => ({ ...g, requests: [] }));
    const by = new Map(groups.map(g => [g.team_id, g]));
    for (const r of rows) by.get(r.target_team_id).requests.push(reqRowOut(r));
    return res.json({ groups, stats });
  }
  const { limit, offset } = pageOf(req);
  const rows = db.prepare(`${REQ_SELECT} WHERE ${W} ORDER BY ${REQ_ORDER} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ requests: rows.map(reqRowOut), total: stats.total, more: offset + rows.length < stats.total, stats });
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
  const sessionOk = db.prepare(`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1
    AND (s.last_active_at IS NULL OR s.last_active_at >= datetime('now', ?))`);
  const ping = setInterval(() => { if (!sessionOk.get(token, `-${IDLE_HOURS} hours`)) return res.end(); res.write(': ping\n\n'); }, 25000);
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
  AND m.deleted_at IS NULL AND m.system = 0 AND (m.sender_id IS NULL OR m.sender_id != cm.user_id))`;
// Unread messages in the user's unmuted chats (the menu count and the desktop badge).
const chatUnreadTotal = uid => db.prepare(`SELECT COALESCE(SUM(${UNREAD}), 0) AS n FROM conversation_members cm WHERE cm.user_id = ? AND cm.muted = 0`).get(uid).n;
// A direct chat is named after the other person.
function chatName(c, uid) {
  if (c.type !== 'direct') return c.name || 'Group';
  const o = db.prepare(`SELECT us.name FROM conversation_members cm JOIN users us ON us.id = cm.user_id
    WHERE cm.conversation_id = ? AND cm.user_id != ?`).get(c.id, uid);
  return o ? o.name : 'Former member';
}
// Group admins (group chats only): the creator, every member whose role is admin, manager, team_manager or lead, and
// members another group admin made one (conversation_members.is_admin). They add and remove people, rename the group
// and make group admins. Team chats follow the team; direct chats can't be changed.
const AUTO_ADMIN_ROLES = ['admin', 'manager', 'team_manager', 'lead'];
// Why a member is a group admin: 'creator', 'role', 'made' or null (also null for non-members and other chat types).
function groupAdminReason(c, userId) {
  if (c.type !== 'group') return null;
  const m = db.prepare(`SELECT us.role, cm.is_admin FROM conversation_members cm JOIN users us ON us.id = cm.user_id
    WHERE cm.conversation_id = ? AND cm.user_id = ?`).get(c.id, userId);
  if (!m) return null;
  return c.created_by === userId ? 'creator' : AUTO_ADMIN_ROLES.includes(m.role) ? 'role' : m.is_admin ? 'made' : null;
}
const canManageChat = (u, c) => c.type === 'group' && !c.archived_at && !!groupAdminReason(c, u.id);
// Removing a member: the creator only by a company manager/admin; another group admin (made one, or by role) only by
// the creator or a company manager/admin; everyone else by any group admin. Taking away admin rights that were given
// (is_admin) follows the same rule, and anyone may give up their own.
function canRemoveChatMember(u, c, targetId) {
  if (!canManageChat(u, c) || targetId === u.id) return false;
  const r = groupAdminReason(c, targetId);
  if (r === 'creator') return isBoss(u);
  return r ? c.created_by === u.id || isBoss(u) : true;
}
function canUnmakeChatAdmin(u, c, targetId) {
  if (c.type !== 'group' || c.archived_at || groupAdminReason(c, targetId) !== 'made') return false;
  return targetId === u.id || (canManageChat(u, c) && (c.created_by === u.id || isBoss(u)));
}
// A small system line in the chat ("X added Y"). Not a message: no notification, not unread, not in previews or search.
function chatSystemLine(convId, actorId, text) {
  db.prepare('INSERT INTO messages (conversation_id, sender_id, body, system) VALUES (?,?,?,1)').run(convId, actorId, text);
}
function messageViews(rows) {
  const files = rows.length ? db.prepare(`SELECT id, message_id, original_name AS name, size, mime FROM files
    WHERE message_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`).all(...rows.map(m => m.id)) : [];
  return rows.map(m => m.deleted_at
    ? { id: m.id, sender_id: m.sender_id, sender_name: m.sender_name, created_at: m.created_at, deleted: true, body: '', files: [] }
    : m.system ? { id: m.id, sender_id: m.sender_id, sender_name: m.sender_name, created_at: m.created_at, deleted: false, system: true, body: m.body, files: [] }
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

// The chat list, 50 at a time (Scale). Order: active chats before archived ones, then the latest activity, then id. The
// cursor ?before=<archived 0|1>|<activity time>|<id> is the last row the page already has, so a chat that moves up the
// list while the person scrolls can't make the next page skip or repeat rows. -> { conversations, more, unread_total }
app.get('/api/chat', auth, (req, res) => {
  const u = req.user, limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const cur = String(req.query.before || '').match(/^([01])\|([\d\- :TZ.]*)\|(\d+)$/);
  const ACT = 'COALESCE(c.last_message_at, c.created_at)', ARCH = '(c.archived_at IS NOT NULL)';
  const after = cur ? `AND (${ARCH} > ? OR (${ARCH} = ? AND (${ACT} < ? OR (${ACT} = ? AND c.id < ?))))` : '';
  const rows = db.prepare(`SELECT c.*, ${ACT} AS activity_at, cm.muted, ${UNREAD} AS unread,
      (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count,
      lm.id AS last_id, lm.body AS last_body, lm.deleted_at AS last_deleted, lm.sender_id AS last_sender_id, ls.name AS last_sender_name,
      (SELECT original_name FROM files f WHERE f.message_id = lm.id ORDER BY f.id LIMIT 1) AS last_file
    FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
    LEFT JOIN messages lm ON lm.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id AND system = 0) LEFT JOIN users ls ON ls.id = lm.sender_id
    WHERE cm.user_id = ? ${after} ORDER BY ${ARCH}, ${ACT} DESC, c.id DESC LIMIT ?`).all(u.id, ...(cur ? [Number(cur[1]), Number(cur[1]), cur[2], cur[2], Number(cur[3])] : []), limit + 1);
  const more = rows.length > limit; if (more) rows.pop();
  const conversations = rows.map(c => ({
    id: c.id, type: c.type, name: chatName(c, u.id), muted: !!c.muted, archived: !!c.archived_at, unread: c.unread, member_count: c.member_count,
    last_message_at: c.last_message_at, activity_at: c.activity_at, can_manage: canManageChat(u, c),
    last: c.last_id ? { sender_name: c.last_sender_id === u.id ? 'You' : c.last_sender_name, deleted: !!c.last_deleted,
      text: c.last_deleted ? 'This message was deleted' : c.last_body ? c.last_body.slice(0, 120) : c.last_file ? '📎 ' + c.last_file : '' } : null
  }));
  res.json({ conversations, more, unread_total: chatUnreadTotal(u.id) });
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
  if (!canManageChat(req.user, c)) { bad(res, c.type === 'group' ? (c.archived_at ? 'This chat is archived.' : 'Only group admins can change this group.') : 'Only groups can be changed.', 403); return null; }
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
  db.transaction(() => { if (addChatMembers(c.id, [p.id]).length) chatSystemLine(c.id, req.user.id, `${req.user.name} added ${p.name}`); })();
  push(memberIds(c.id), 'conversation', { conversation_id: c.id });
  res.json({ ok: true });
});
app.delete('/api/chat/:id/members/:userId', auth, (req, res) => {
  const c = managedChat(req, res); if (!c) return;
  const uid = Number(req.params.userId);
  if (uid === req.user.id) return bad(res, 'Use "Leave" to leave the group.');
  const before = memberIds(c.id);
  if (!before.includes(uid)) return bad(res, 'This person isn’t in the group.', 404);
  if (!canRemoveChatMember(req.user, c, uid)) return bad(res, groupAdminReason(c, uid) === 'creator'
    ? 'Only a company manager or admin can remove the person who made the group.'
    : 'Only the person who made the group or a company manager or admin can remove another group admin.', 403);
  const who = db.prepare('SELECT name FROM users WHERE id = ?').get(uid);
  db.transaction(() => {
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(c.id, uid);
    chatSystemLine(c.id, req.user.id, `${req.user.name} removed ${who.name}`);
  })();
  push(before, 'conversation', { conversation_id: c.id });
  res.json({ ok: true });
});
// Make a member a group admin (any group admin) / take back admin rights that were given (see canUnmakeChatAdmin).
app.put('/api/chat/:id/admins/:userId', auth, (req, res) => {
  const c = managedChat(req, res); if (!c) return;
  const uid = Number(req.params.userId);
  if (!memberIds(c.id).includes(uid)) return bad(res, 'This person isn’t in the group.', 404);
  if (groupAdminReason(c, uid)) return bad(res, 'This person is already a group admin.', 409);
  const who = db.prepare('SELECT name FROM users WHERE id = ?').get(uid);
  db.transaction(() => {
    db.prepare('UPDATE conversation_members SET is_admin = 1 WHERE conversation_id = ? AND user_id = ?').run(c.id, uid);
    chatSystemLine(c.id, req.user.id, `${req.user.name} made ${who.name} a group admin`);
  })();
  push(memberIds(c.id), 'conversation', { conversation_id: c.id });
  res.json({ ok: true });
});
app.delete('/api/chat/:id/admins/:userId', auth, (req, res) => {
  const c = chatMember(req.user, req.params.id);
  if (!c) return bad(res, 'Conversation not found.', 404);
  const uid = Number(req.params.userId), why = groupAdminReason(c, uid);
  if (why === 'creator' || why === 'role') return bad(res, why === 'creator' ? 'The person who made the group is always a group admin.' : 'This person is a group admin because of their role.', 409);
  if (why !== 'made') return bad(res, 'This person isn’t a group admin.', 404);
  if (!canUnmakeChatAdmin(req.user, c, uid)) return bad(res, 'Only the person who made the group or a company manager or admin can take away another group admin’s rights.', 403);
  const who = db.prepare('SELECT name FROM users WHERE id = ?').get(uid);
  db.transaction(() => {
    db.prepare('UPDATE conversation_members SET is_admin = 0 WHERE conversation_id = ? AND user_id = ?').run(c.id, uid);
    chatSystemLine(c.id, req.user.id, uid === req.user.id ? `${who.name} gave up group admin rights` : `${req.user.name} removed ${who.name}’s group admin rights`);
  })();
  push(memberIds(c.id), 'conversation', { conversation_id: c.id });
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
    WHERE m.deleted_at IS NULL AND m.system = 0 AND (m.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id AND f.original_name LIKE ? ESCAPE '\\'))
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
  // admin: why the member is a group admin ('creator', 'role', 'made' or null); can_*: what this user may do to them.
  const members = db.prepare(`SELECT us.id, us.name, us.active, tm.name AS team_name FROM conversation_members cm JOIN users us ON us.id = cm.user_id
    LEFT JOIN teams tm ON tm.id = us.team_id WHERE cm.conversation_id = ? ORDER BY us.name`).all(c.id).map(m => {
      const admin = groupAdminReason(c, m.id), manage = canManageChat(u, c);
      return { ...m, active: !!m.active, admin, can_remove: canRemoveChatMember(u, c, m.id),
        can_make_admin: manage && !admin, can_unmake_admin: canUnmakeChatAdmin(u, c, m.id) };
    });
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
  if (m.sender_id !== req.user.id || m.system) return bad(res, 'You can only delete your own messages.', 403);
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
  if (!fs.existsSync(file)) return bad(res, 'File not found.', 404);
  if (inline) res.set({ 'Cache-Control': 'private, max-age=86400' });
  else {
    res.attachment(f.original_name);
    audit(req, 'file_downloaded', { target: { type: 'file', id: f.id, name: f.original_name },
      details: f.message_id ? `chat message #${f.message_id}` : f.task_id ? `task #${f.task_id}` : f.request_id ? `request #${f.request_id}` : 'shared assignment file' });
  }
  res.type(type);
  res.set('Content-Length', String(f.size)); // the plain size, checked against every file when they were encrypted
  // Decrypted on the fly (filecrypt.js). If the file is damaged the transfer stops with an error rather than finishing.
  pipeline(fs.createReadStream(file), filecrypt.decryptStream(), res).catch(err => {
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return; // the browser stopped the download
    console.error(`[files] file ${f.id} could not be sent: ${err.message}`);
    if (!res.headersSent) bad(res, 'This file can’t be read.', 500); else res.destroy();
  });
});

// ---------- history ----------
// One row per document request (with its linked task) and one per task that isn't a request's task.
const LATEST_SUBMIT = `(SELECT MAX(created_at) FROM task_updates WHERE task_id = t.id AND message LIKE 'Submitted for approval%')`;
const LATEST_APPROVE = `(SELECT MAX(created_at) FROM task_updates WHERE task_id = t.id AND status = 'completed' AND (message LIKE 'Approved%' OR message LIKE 'Self-approved by %'))`;
const SELF_APPROVED = `EXISTS (SELECT 1 FROM task_updates WHERE task_id = t.id AND message LIKE 'Self-approved by %')`;
const SEND_BACKS = `(SELECT group_concat(substr(message, 12), ' | ') FROM task_updates WHERE task_id = t.id AND message LIKE 'Sent back: %')`;
// The two kinds of History row. Shared by the full list (historyRows: the CSV) and the paged one (historyPage).
const HIST_TASK_SELECT = `SELECT 'task' AS type, t.id, t.title, t.status, a.team_id, tm.name AS team_name,
      t.assignee_id, a.name AS assignee_name, t.assigned_by, b.name AS assigned_by_name, NULL AS requested_by, NULL AS requested_by_name,
      t.created_at AS assigned_at, ${LATEST_SUBMIT} AS submitted_at, ${LATEST_APPROVE} AS approved_at, t.completed_at,
      ab.name AS approved_by_name, t.status = 'completed' AND ${SELF_APPROVED} AS self_approved, ${SEND_BACKS} AS send_back_reasons, t.created_at AS created_at, t.id AS task_id,
      t.deleted_at, td.name AS deleted_by_name
    FROM tasks t JOIN users a ON a.id = t.assignee_id JOIN users b ON b.id = t.assigned_by
    LEFT JOIN teams tm ON tm.id = a.team_id LEFT JOIN users ab ON ab.id = t.approved_by LEFT JOIN users td ON td.id = t.deleted_by`;
const HIST_REQ_SELECT = `SELECT 'request' AS type, r.id, r.title, r.status, r.target_team_id AS team_id, tm.name AS team_name,
      t.assignee_id, a.name AS assignee_name, t.assigned_by, b.name AS assigned_by_name, r.requested_by, rb.name AS requested_by_name,
      t.created_at AS assigned_at, ${LATEST_SUBMIT} AS submitted_at, ${LATEST_APPROVE} AS approved_at, r.closed_at AS completed_at,
      ab.name AS approved_by_name, t.status = 'completed' AND ${SELF_APPROVED} AS self_approved, ${SEND_BACKS} AS send_back_reasons, r.created_at AS created_at, r.task_id,
      r.deleted_at, rd.name AS deleted_by_name
    FROM requests r JOIN users rb ON rb.id = r.requested_by LEFT JOIN teams tm ON tm.id = r.target_team_id LEFT JOIN users rd ON rd.id = r.deleted_by
    LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users b ON b.id = t.assigned_by
    LEFT JOIN users ab ON ab.id = t.approved_by`;
const HIST_NOT_REQUEST_TASK = `t.id NOT IN (SELECT task_id FROM requests WHERE task_id IS NOT NULL)`;
function historyFixups(u, rows) {
  // A task approved directly (no "Approved" update) still has an approval date: when it was completed.
  for (const r of rows) if (!r.approved_at && r.type === 'task' && r.approved_by_name && r.completed_at) r.approved_at = r.completed_at;
  for (const r of rows) if (r.type === 'request' && r.status === 'needs_team') r.team_name = 'Not decided yet';
  for (const r of rows) if (r.self_approved && r.approved_by_name) r.approved_by_name += ' (self-approved)';
  for (const r of rows) if (r.deleted_at) { r.status = 'deleted'; r.can_restore = canManageArchived(u, r.team_id); }
  return rows;
}
function historyRows(u, q) {
  const s = taskScope(u, true); // History also lists archived (deleted) tasks and requests, with status deleted
  const taskRows = db.prepare(`${HIST_TASK_SELECT} WHERE ${s.sql} AND ${HIST_NOT_REQUEST_TASK}`).all(...s.params);
  // Requests: the same people who can see them on the board (requestScope).
  const { sql: rsql, params: rparams } = requestScope(u, true);
  const reqRows = db.prepare(`${HIST_REQ_SELECT} WHERE ${rsql}`).all(...rparams);
  let rows = historyFixups(u, taskRows.concat(reqRows));
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
// The same list as historyRows, one page at a time (Scale), with the filters done in SQL. Two steps: first only the keys
// (type, id, created_at) of every matching row, newest first, which is cheap; then the full rows, with their
// per-row look-ups (submitted/approved dates, send-back reasons), for just the page. Returns { rows, total }.
function historyPage(u, q, limit, offset) {
  const k = historyKeys(u, q, limit, offset);
  return { rows: historyRowsFor(u, k.keys), total: k.total };
}
// Step 1: the keys (and the total) of the matching rows, newest first. limit = null: all of them (the CSV export).
function historyKeys(u, q, limit, offset) {
  const person = Number(q.person), team = Number(q.team);
  const f = { task: [], req: [] }, p = { task: [], req: [] };
  if (person) { f.task.push('(t.assignee_id = ? OR t.assigned_by = ?)'); p.task.push(person, person); f.req.push('(t.assignee_id = ? OR t.assigned_by = ? OR r.requested_by = ?)'); p.req.push(person, person, person); }
  if (team) { f.task.push('a.team_id = ?'); p.task.push(team); f.req.push('r.target_team_id = ?'); p.req.push(team); }
  else if (q.team === 'none') { f.task.push('a.team_id IS NULL'); f.req.push('r.target_team_id IS NULL'); }
  if (q.status) { // "deleted" is what an archived row shows instead of its own status
    f.task.push(`CASE WHEN t.deleted_at IS NOT NULL THEN 'deleted' ELSE t.status END = ?`); p.task.push(String(q.status));
    f.req.push(`CASE WHEN r.deleted_at IS NOT NULL THEN 'deleted' ELSE r.status END = ?`); p.req.push(String(q.status));
  }
  if (DATE_RE.test(q.from || '')) { f.task.push('substr(t.created_at, 1, 10) >= ?'); p.task.push(q.from); f.req.push('substr(r.created_at, 1, 10) >= ?'); p.req.push(q.from); }
  if (DATE_RE.test(q.to || '')) { f.task.push('substr(t.created_at, 1, 10) <= ?'); p.task.push(q.to); f.req.push('substr(r.created_at, 1, 10) <= ?'); p.req.push(q.to); }
  const ts = taskScope(u, true), rs = requestScope(u, true);
  const T = `FROM tasks t JOIN users a ON a.id = t.assignee_id WHERE ${ts.sql} AND ${HIST_NOT_REQUEST_TASK}${f.task.map(x => ' AND ' + x).join('')}`;
  const R = `FROM requests r JOIN users rb ON rb.id = r.requested_by LEFT JOIN tasks t ON t.id = r.task_id WHERE ${rs.sql}${f.req.map(x => ' AND ' + x).join('')}`;
  const tp = [...ts.params, ...p.task], rp = [...rs.params, ...p.req];
  const total = db.prepare(`SELECT (SELECT COUNT(*) ${T}) + (SELECT COUNT(*) ${R}) AS n`).get(...tp, ...rp).n;
  const keys = db.prepare(`SELECT type, id FROM (SELECT 'task' AS type, t.id AS id, t.created_at AS created_at ${T} UNION ALL SELECT 'request', r.id, r.created_at ${R})
    ORDER BY created_at DESC, type, id DESC${limit === null ? '' : ' LIMIT ? OFFSET ?'}`).all(...tp, ...rp, ...(limit === null ? [] : [limit, offset]));
  return { keys, total };
}
// Step 2: the full rows (with their per-row look-ups) for some keys, in the order of the keys.
function historyRowsFor(u, keys) {
  const ids = type => keys.filter(k => k.type === type).map(k => k.id);
  const tIds = ids('task'), rIds = ids('request');
  const rows = historyFixups(u, [
    ...(tIds.length ? db.prepare(`${HIST_TASK_SELECT} WHERE t.id IN (${tIds.map(() => '?').join(',')})`).all(...tIds) : []),
    ...(rIds.length ? db.prepare(`${HIST_REQ_SELECT} WHERE r.id IN (${rIds.map(() => '?').join(',')})`).all(...rIds) : [])]);
  const at = new Map(rows.map(r => [r.type + '/' + r.id, r]));
  return keys.map(k => at.get(k.type + '/' + k.id)).filter(Boolean); // (a row removed meanwhile is left out)
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
app.get('/api/history', auth, ah(async (req, res) => {
  // The page asks for ?limit= (a page at a time); the CSV and old callers get every matching row.
  if (req.query.format !== 'csv' && req.query.limit !== undefined) {
    const { limit, offset } = pageOf(req, 100), h = historyPage(req.user, req.query, limit, offset);
    return res.json({ rows: h.rows, total: h.total, more: offset + h.rows.length < h.total });
  }
  if (req.query.format !== 'csv') return res.json({ rows: historyRows(req.user, req.query) });
  const cols = [['Title', r => r.title], ['Type', r => r.type === 'request' ? 'Request' : 'Task'], ['Status', r => STATUS_LABEL[r.status] || r.status],
    ['Team', r => r.team_name], ['Assigned to', r => r.assignee_name], ['Assigned by', r => r.assigned_by_name], ['Requested by', r => r.requested_by_name],
    ['Assigned date', r => localTime(r.assigned_at)], ['Submitted date', r => localTime(r.submitted_at)], ['Approved date', r => localTime(r.approved_at)],
    ['Completed date', r => localTime(r.completed_at)], ['Approved by', r => r.approved_by_name], ['Send-back reasons', r => r.send_back_reasons],
    ['Deleted', r => r.deleted_at ? `Deleted by ${r.deleted_by_name || 'unknown'} on ${localTime(r.deleted_at)}` : '']];
  // The CSV is built and sent in batches of 500 rows, giving other requests a turn in between (Scale): one big export of
  // 36,000 rows used to hold the whole server for about a second. The rows are the same as before (newest first).
  const keys = historyKeys(req.user, req.query, null, 0);
  audit(req, 'history_exported', { details: `${keys.total} rows; filters ${JSON.stringify(Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'format')))}` });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`taskdesk-history-${new Date().toISOString().slice(0, 10)}.csv`);
  res.write('﻿' + cols.map(c => csvCell(c[0])).join(',') + '\r\n');
  for (let i = 0; i < keys.keys.length; i += 500) {
    const rows = historyRowsFor(req.user, keys.keys.slice(i, i + 500));
    if (rows.length) res.write(rows.map(r => cols.map(c => csvCell(c[1](r))).join(',')).join('\r\n') + '\r\n');
    await new Promise(r => setImmediate(r));
    if (res.destroyed) return; // the person closed the download
  }
  res.end();
}));

// ---------- audit log page (admins only; read and export, nothing else) ----------
// Filters: from / to (YYYY-MM-DD, local dates), action, q (text in who, target, details or IP). Newest first, 200 per
// page (before=<id> for the next page). format=csv exports everything that matches (up to 50,000 rows) and is itself
// recorded.
const AUDIT_ACTIONS = ['sign_in', 'sign_in_failed', 'account_locked', 'signed_out_other_devices', 'password_changed', 'password_reset_requested',
  'password_reset', 'password_set_by_manager', 'welcome_resent', 'person_added', 'person_edited', 'role_changed', 'team_changed', 'lead_changed',
  'managed_teams_changed', 'team_leads_changed', 'team_managers_changed', 'team_deleted', 'protection_changed', 'account_activated',
  'account_deactivated', 'person_removed', 'person_restored', '2fa_enabled', '2fa_disabled', '2fa_recovery_codes_renewed', '2fa_reset',
  'people_imported', 'team_created', 'virus_blocked', 'file_downloaded', 'history_exported', 'audit_exported'];
function auditWhere(q) {
  const where = [], params = [];
  if (DATE_RE.test(String(q.from || ''))) { where.push(`date(at, 'localtime') >= ?`); params.push(q.from); }
  if (DATE_RE.test(String(q.to || ''))) { where.push(`date(at, 'localtime') <= ?`); params.push(q.to); }
  if (AUDIT_ACTIONS.includes(q.action)) { where.push('action = ?'); params.push(q.action); }
  const text = str(q.q, 100);
  if (text) { where.push(`(actor_name LIKE ? ESCAPE '\\' OR target_name LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')`); params.push(...Array(4).fill(likeText(text))); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
app.get('/api/audit', auth, requireAdmin, (req, res) => {
  const w = auditWhere(req.query);
  if (req.query.format === 'csv') {
    const rows = db.prepare(`SELECT * FROM audit_log ${w.sql} ORDER BY id DESC LIMIT 50000`).all(...w.params);
    audit(req, 'audit_exported', { details: `${rows.length} rows; filters ${JSON.stringify(Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'format')))}` });
    const cols = [['When', r => localTime(r.at)], ['Who', r => r.actor_name || '(not signed in)'], ['IP', r => r.ip], ['Action', r => r.action],
      ['Target type', r => r.target_type], ['Target', r => r.target_name], ['Details', r => r.details]];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`taskdesk-audit-${new Date().toISOString().slice(0, 10)}.csv`);
    return res.send('\ufeff' + [cols.map(c => csvCell(c[0])).join(',')].concat(rows.map(r => cols.map(c => csvCell(c[1](r))).join(','))).join('\r\n') + '\r\n');
  }
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`SELECT * FROM audit_log ${w.sql ? w.sql + ' AND' : 'WHERE'} id < ? ORDER BY id DESC LIMIT 201`).all(...w.params, before);
  res.json({ entries: rows.slice(0, 200), more: rows.length > 200, actions: AUDIT_ACTIONS });
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
    ready_requests, needs_team_requests, assign_requests, unassigned_reminders, team_asks, withdrawn, task_notes, chat_unread: chatUnreadTotal(u.id),
    ...(MOVED_TO ? { moved_to: MOVED_TO } : {}) });
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
// The virus scanner can take a few minutes to load its signatures after a start; until then uploads are refused.
scanner.ping().then(up => console.log(up ? `[scan] ClamAV ready at ${scanner.HOST}:${scanner.PORT}` : `[scan] ClamAV not reachable yet at ${scanner.HOST}:${scanner.PORT}; uploads are refused until it is`));

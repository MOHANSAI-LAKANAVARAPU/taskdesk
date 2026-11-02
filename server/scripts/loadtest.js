// TaskDesk load test tools (Scale).
//   node scripts/loadtest.js seed --data <folder>     fill a COPY of the database with 600 temporary people and a year of data
//   node scripts/loadtest.js run  --url http://127.0.0.1:3001 --data <folder> --container <name> [--minutes 10] [--scale 1] [--out <file.json>]
//       600 people sign in (a login storm in the first minute), keep /api/stream open, poll /api/my-summary every minute like the
//       desktop app, open pages, chat, upload small files and update tasks, for --minutes minutes; then prints median/95th-percentile
//       times, errors, memory and CPU of the containers and the database growth.
// SAFETY: this only ever works on a copy server's data folder, never the live one. The audit log is append-only, so test
// entries could never be removed from the live log. `--data` must be a folder that holds a file named
// ".taskdesk-test-copy" (made by whoever copied the database), and must not be server/data. Everything it creates is
// tagged: people zz-load-*@test.local, teams "ZZ Load Team NN", projects "ZZ Load Project NN", chats "ZZ Load ...". Delete the
// copy's whole data folder when done.
// Needs master.key (SECRETS_DIR, default server/secrets) because the database is encrypted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER = path.resolve(__dirname, '..');
const argv = process.argv.slice(2), mode = argv[0];
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const die = m => { console.error('STOPPED: ' + m); process.exit(1); };

function copyDataDir() {
  const dir = arg('data');
  if (!dir) die('give the copy server\'s data folder: --data <folder>');
  const real = fs.realpathSync(dir);
  if (real === fs.realpathSync(path.join(SERVER, 'data'))) die('that is the LIVE data folder. This tool only works on a copy.');
  if (!fs.existsSync(path.join(real, '.taskdesk-test-copy'))) die(`${real} has no .taskdesk-test-copy marker file, so it is not a known test copy.`);
  return real;
}

// ---------- seed ----------
function seed() {
  const dir = copyDataDir();
  process.env.SECRETS_DIR = process.env.SECRETS_DIR || path.join(SERVER, 'secrets');
  const dbfile = require(path.join(SERVER, 'dbfile.js'));
  const bcrypt = require(path.join(SERVER, 'node_modules', 'bcryptjs'));
  const db = dbfile.openDb(path.join(dir, 'taskdesk.db'));
  db.pragma('foreign_keys = ON');
  if (db.prepare(`SELECT 1 FROM users WHERE email LIKE 'zz-load-%'`).get()) die('this copy already holds load-test data.');
  let s = 20261031; // fixed seed: the same data every time
  const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = arr => arr[Math.floor(rnd() * arr.length)];
  const weighted = pairs => { let x = rnd() * pairs.reduce((a, p) => a + p[1], 0); for (const [v, w] of pairs) { if ((x -= w) < 0) return v; } return pairs[0][0]; };
  const NOW = Date.now(), fmt = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' '), ago = days => fmt(NOW - days * 864e5), day = ms => new Date(ms).toISOString().slice(0, 10);
  const WORDS = 'the release test firmware camera review document update schedule customer report fix build deploy approve check sample batch lot quality plan design module driver network stream server sensor lens board'.split(' ');
  const text = (a, b) => Array.from({ length: int(a, b) }, () => pick(WORDS)).join(' ');
  const t0 = Date.now(), added = {};
  const count = (k, n = 1) => { added[k] = (added[k] || 0) + n; };

  db.transaction(() => {
    // teams, people, sessions
    const hash = bcrypt.hashSync('Zz-load-pass-1', 10), ins = {
      team: db.prepare('INSERT INTO teams (name) VALUES (?)'),
      user: db.prepare('INSERT INTO users (name, email, password_hash, role, team_id, created_at) VALUES (?,?,?,?,?,?)'),
      session: db.prepare(`INSERT INTO sessions (token, user_id, expires_at, last_active_at) VALUES (?,?,datetime('now','+1 day'),datetime('now'))`) };
    const pad = (n, w) => String(n).padStart(w, '0');
    const teams = Array.from({ length: 40 }, (_, i) => { const id = ins.team.run(`ZZ Load Team ${pad(i + 1, 2)}`).lastInsertRowid; count('teams'); return { id, members: [], lead: null }; });
    const people = [], mk = (name, email, role, team) => { const id = ins.user.run(name, email, hash, role, team ? team.id : null, ago(int(30, 400))).lastInsertRowid; const u = { id, role, team }; people.push(u); count('users');
      ins.session.run('zzload' + crypto.randomBytes(16).toString('hex'), id); return u; };
    let n = 0;
    for (const t of teams) for (let k = 0; k < 14; k++) { const u = mk(`Load User ${pad(++n, 4)}`, `zz-load-${pad(n, 4)}@test.local`, k === 0 ? 'lead' : 'employee', t); t.members.push(u); if (k === 0) t.lead = u; }
    const managers = [1, 2, 3].map(i => mk(`Load Manager ${i}`, `zz-load-mgr-${i}@test.local`, 'manager', null));
    const admins = [1, 2].map(i => mk(`Load Admin ${i}`, `zz-load-admin-${i}@test.local`, 'admin', null));
    const tms = [0, 1, 2, 3].map(i => mk(`Load TeamManager ${i + 1}`, `zz-load-tm-${i + 1}@test.local`, 'team_manager', teams[i * 10]));
    while (people.length < 600) mk(`Load User ${pad(++n, 4)}`, `zz-load-${pad(n, 4)}@test.local`, 'employee', null);
    const lead = db.prepare('INSERT INTO team_leads (team_id, user_id, added_by) VALUES (?,?,?)'); for (const t of teams) { lead.run(t.id, t.lead.id, admins[0].id); count('team_leads'); }
    const tm = db.prepare('INSERT INTO team_managers (team_id, user_id, added_by) VALUES (?,?,?)'); tms.forEach((m, i) => { for (let k = 0; k < 10; k++) { tm.run(teams[i * 10 + k].id, m.id, admins[0].id); count('team_managers'); } });
    // projects
    const proj = db.prepare('INSERT INTO projects (name, description, created_by, created_at) VALUES (?,?,?,?)'), pt = db.prepare('INSERT INTO project_teams (project_id, team_id) VALUES (?,?)');
    teams.forEach((t, i) => { t.projects = [proj.run(`ZZ Load Project ${pad(i + 1, 2)}`, text(3, 8), admins[0].id, ago(int(100, 400))).lastInsertRowid]; pt.run(t.projects[0], t.id); count('projects'); });

    // tasks (each with an "assigned" update and, if started, a progress update)
    const tIns = db.prepare(`INSERT INTO tasks (title, description, project_id, assignee_id, assigned_by, priority, status, progress, start_date, deadline, completed_at, submitted_at, approved_by, created_at, updated_at, deleted_at, deleted_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const uIns = db.prepare('INSERT INTO task_updates (task_id, user_id, message, progress, status, created_at, note_kind) VALUES (?,?,?,?,?,?,?)');
    function makeTask(team, assignee, assigner, forceStatus) {
      const status = forceStatus || weighted([['assigned', 15], ['in_progress', 15], ['submitted', 5], ['completed', 65]]);
      const ageDays = status === 'completed' ? int(1, 365) : int(0, 75), created = NOW - ageDays * 864e5 - int(0, 86400) * 1000;
      const deadline = rnd() < 0.1 ? null : day(created + int(3, 40) * 864e5);
      const done = status === 'completed' ? created + int(1, 30) * 864e5 : null, subm = status === 'submitted' || status === 'completed' ? (done || created + int(1, 20) * 864e5) - 3600e3 : null;
      const deleted = !forceStatus && rnd() < 0.05, prog = status === 'completed' ? 100 : status === 'submitted' ? 100 : status === 'in_progress' ? int(5, 90) : 0;
      const id = tIns.run(`${pick(['Review', 'Test', 'Prepare', 'Fix', 'Update', 'Document', 'Check'])} ${text(2, 5)}`, text(8, 30), rnd() < 0.7 ? pick(team.projects) : null, assignee.id, assigner.id,
        weighted([['low', 20], ['medium', 50], ['high', 22], ['urgent', 8]]), status, prog, day(created), deadline, done && fmt(done), subm && fmt(subm), status === 'completed' ? assigner.id : null,
        fmt(created), fmt(done || created), deleted ? fmt(created + 5 * 864e5) : null, deleted ? assigner.id : null).lastInsertRowid;
      uIns.run(id, assigner.id, 'Assigned to a team member', 0, 'assigned', fmt(created), ''); count('task_updates');
      if (status !== 'assigned') { uIns.run(id, assignee.id, text(4, 14), prog, status === 'submitted' ? 'in_progress' : status, fmt(created + 3600e3 * int(2, 200)), 'note'); count('task_updates'); }
      count('tasks'); return id;
    }
    for (let i = 0; i < 30000; i++) { const t = pick(teams); makeTask(t, pick(t.members), rnd() < 0.8 ? t.lead : pick(managers)); }

    // requests (assigned/delivered/closed ones have their own task)
    const rIns = db.prepare(`INSERT INTO requests (title, description, needed_by, requested_by, target_team_id, status, task_id, created_at, delivered_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const eIns = db.prepare('INSERT INTO request_events (request_id, user_id, message, created_at) VALUES (?,?,?,?)');
    for (let i = 0; i < 6000; i++) {
      const t = pick(teams), by = pick(people), status = weighted([['open', 10], ['needs_team', 3], ['assigned', 12], ['delivered', 15], ['closed', 55], ['cancelled', 5]]);
      const created = NOW - int(0, 365) * 864e5, worker = pick(t.members);
      const taskId = ['assigned', 'delivered', 'closed'].includes(status) ? makeTask(t, worker, worker, status === 'assigned' ? 'in_progress' : 'completed') : null;
      const rid = rIns.run(`Document ${text(2, 4)}`, text(5, 20), day(created + int(2, 20) * 864e5), by.id, status === 'needs_team' ? null : t.id, status, taskId, fmt(created),
        status === 'delivered' || status === 'closed' ? fmt(created + 5 * 864e5) : null, status === 'closed' ? fmt(created + 6 * 864e5) : null).lastInsertRowid;
      eIns.run(rid, by.id, `Sent to ${t.id}`, fmt(created)); count('requests'); count('request_events');
    }

    // chats: one per team, 300 direct, 40 groups; 100,000 messages with some unread for each member
    const cIns = db.prepare('INSERT INTO conversations (type, name, team_id, created_by, created_at) VALUES (?,?,?,?,?)'), mIns = db.prepare('INSERT INTO conversation_members (conversation_id, user_id, last_read_message_id) VALUES (?,?,0)');
    const msgIns = db.prepare('INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?,?,?,?)');
    const fill = (members, nMsgs, spanDays, label) => {
      const cid = label.id; let first = null, last = null, lastAt = null;
      const times = Array.from({ length: nMsgs }, () => NOW - rnd() * spanDays * 864e5).sort((a, b) => a - b);
      for (const ms of times) { const id = msgIns.run(cid, pick(members).id, text(3, 25), fmt(ms)).lastInsertRowid; if (!first) first = id; last = id; lastAt = fmt(ms); count('messages'); }
      for (const m of members) { mIns.run(cid, m.id); db.prepare('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?').run(Math.max(first || 0, (last || 0) - (rnd() < 0.5 ? 0 : int(1, 8))), cid, m.id); }
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(lastAt, cid); count('conversation_members', members.length);
    };
    for (const t of teams) { const id = cIns.run('team', t.id && `ZZ Load Team ${pad(teams.indexOf(t) + 1, 2)}`, t.id, null, ago(200)).lastInsertRowid; count('conversations'); fill(t.members, 1500, 180, { id }); }
    for (let i = 0; i < 300; i++) { const a = pick(people); let b = pick(people); if (b === a) b = people[(people.indexOf(a) + 1) % people.length]; const id = cIns.run('direct', null, null, a.id, ago(150)).lastInsertRowid; count('conversations'); fill([a, b], 70, 150, { id }); }
    for (let i = 0; i < 40; i++) { const mem = Array.from(new Set(Array.from({ length: int(5, 20) }, () => pick(people)))); const id = cIns.run('group', `ZZ Load Group ${pad(i + 1, 2)}`, null, mem[0].id, ago(150)).lastInsertRowid; count('conversations'); fill(mem, 475, 150, { id }); }

    // audit log (append-only; fine on a copy)
    const aIns = db.prepare('INSERT INTO audit_log (at, actor_id, actor_name, ip, action, target_type, target_id, target_name, details) VALUES (?,?,?,?,?,?,?,?,?)');
    const times = Array.from({ length: 50000 }, () => NOW - rnd() * 365 * 864e5).sort((a, b) => a - b);
    for (const ms of times) { const u = pick(people), act = weighted([['sign_in', 50], ['file_downloaded', 20], ['sign_in_failed', 8], ['person_edited', 6], ['history_exported', 3], ['password_changed', 3], ['team_changed', 5], ['role_changed', 5]]);
      aIns.run(fmt(ms), u.id, `Load User ${u.id}`, `10.${int(0, 5)}.${int(0, 255)}.${int(1, 254)}`, act, 'person', u.id, `Load User ${u.id}`, act === 'sign_in' ? '' : text(3, 8)); count('audit_log'); }
  })();
  db.exec('ANALYZE'); // so the query planner has real statistics, as it will after a while in production
  console.log(`seeded ${dir} in ${Math.round((Date.now() - t0) / 1000)} s:`, JSON.stringify(added));
  console.log(`database: ${(fs.statSync(path.join(dir, 'taskdesk.db')).size / 1048576).toFixed(1)} MB (+ WAL ${((fs.existsSync(path.join(dir, 'taskdesk.db-wal')) ? fs.statSync(path.join(dir, 'taskdesk.db-wal')).size : 0) / 1048576).toFixed(1)} MB)`);
  db.close();
}


// ---------- run ----------
// The traffic is an ASSUMED profile (rates are for the whole company, --scale multiplies them): each person polls /api/my-summary
// once a minute and keeps a stream open; about 5 page views a second, 3 chat messages, 1 small upload, 2 task updates, 0.3 new
// tasks, 0.3 submissions and 0.1 admin actions a second, from the end of the first minute. That is well above typical use.
async function run() {
  const http = require('http'), { execFileSync } = require('child_process'), { performance } = require('perf_hooks');
  const dir = copyDataDir();
  const url = new URL(arg('url', '')); const port = url.port || '80';
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || port === '3000') die('--url must be a copy server on this computer (not port 3000, the live server).');
  const ctr = arg('container', 'taskdesk-copytest');
  if (ctr === 'taskdesk') die('--container is the live container.');
  const docker = (...a) => { try { return execFileSync('docker', a, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return ''; } };
  const mounts = JSON.parse(docker('inspect', ctr, '--format', '{{json .Mounts}}') || '[]'), pub = docker('inspect', ctr, '--format', '{{json .NetworkSettings.Ports}}');
  if (!mounts.some(m => { try { return fs.realpathSync(m.Source) === dir; } catch (e) { return false; } }) || !pub.includes(`"HostPort":"${port}"`)) die(`container ${ctr} doesn't use ${dir} and publish port ${port}, so it isn't the copy server for this data folder.`);
  const minutes = Number(arg('minutes', 10)), scale = Number(arg('scale', 1)), STORM_MS = 60e3, END = Date.now() + minutes * 60e3;
  const base = `http://127.0.0.1:${port}`, LIVE = 'http://127.0.0.1:3000';
  process.env.SECRETS_DIR = process.env.SECRETS_DIR || path.join(SERVER, 'secrets');
  const dbfile = require(path.join(SERVER, 'dbfile.js'));
  const db = dbfile.openDb(path.join(dir, 'taskdesk.db'), { readonly: true });
  const T0 = performance.now(), since = () => performance.now() - T0, rnd = (a, b) => a + Math.random() * (b - a), pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let stopping = null; const stop = why => { if (!stopping) { stopping = why; console.log('\n*** STOPPING: ' + why); } };

  // ---- people, their chats and tasks (from the seeded copy)
  const people = db.prepare(`SELECT id, email, role, team_id FROM users WHERE email LIKE 'zz-load-%' AND active = 1 AND removed_at IS NULL ORDER BY id`).all();
  if (people.length < 100) die('this copy has not been seeded (node scripts/loadtest.js seed --data <folder>).');
  const convs = new Map(), tasksOf = new Map();
  for (const r of db.prepare('SELECT user_id, conversation_id FROM conversation_members').all()) { if (!convs.has(r.user_id)) convs.set(r.user_id, []); convs.get(r.user_id).push(r.conversation_id); }
  for (const r of db.prepare(`SELECT assignee_id, id, status FROM tasks WHERE deleted_at IS NULL AND status IN ('assigned','in_progress') ORDER BY id DESC LIMIT 60000`).all()) { if (!tasksOf.has(r.assignee_id)) tasksOf.set(r.assignee_id, []); if (tasksOf.get(r.assignee_id).length < 40) tasksOf.get(r.assignee_id).push(r); }
  const members = new Map(); for (const u of people) { if (!members.has(u.team_id)) members.set(u.team_id, []); members.get(u.team_id).push(u); }
  const teamMembers = u => (members.get(u.team_id) || []).filter(m => m.id !== u.id);
  const leads = people.filter(u => u.role === 'lead' || u.role === 'manager'), admins = people.filter(u => u.role === 'admin');
  const dbBytes = () => ['taskdesk.db', 'taskdesk.db-wal'].reduce((a, f) => a + (fs.existsSync(path.join(dir, f)) ? fs.statSync(path.join(dir, f)).size : 0), 0);
  const dbStart = dbBytes(), upBytes0 = (() => { try { return fs.readdirSync(path.join(dir, 'uploads')).length; } catch (e) { return 0; } })();

  // ---- measuring
  const lat = {}, errs = {}, counters = { sseUp: 0, sseDown: 0, sseEvents: 0, sseMsgs: 0, logins: 0, loginFail: 0 }, delivery = [];
  const rec = (label, ms, status, err) => { (lat[label] = lat[label] || []).push([since(), ms]); if (status >= 400 || status === 0) { const e = errs[label] = errs[label] || { n: 0, sample: {} }; e.n++; const k = status || err || 'error'; e.sample[k] = (e.sample[k] || 0) + 1; } };
  const pct = (arr, p) => { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))]; };
  async function call(u, label, method, p, { json, form, noAuth } = {}) {
    const t = performance.now();
    try {
      const res = await fetch(base + p, { method, headers: { ...(noAuth ? {} : { Cookie: 'sid=' + u.token }), ...(u && u.csrf && method !== 'GET' ? { 'X-CSRF-Token': u.csrf } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : form });
      const text = await res.text(); rec(label, performance.now() - t, res.status);
      return { status: res.status, text, headers: res.headers, json: () => { try { return JSON.parse(text); } catch (e) { return null; } } };
    } catch (e) { rec(label, performance.now() - t, 0, e.cause && e.cause.code || e.code || e.name); return { status: 0, text: '', json: () => null }; }
  }

  // Admins and managers must set up two-step verification at their first sign-in (their session can do nothing else), so the test
  // does that too, like a new admin would: a TOTP code computed from the secret the server hands out.
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const totp = secret => { let bits = ''; for (const c of secret.replace(/\s/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
    const key = Buffer.from((bits.match(/.{8}/g) || []).map(x => parseInt(x, 2))), m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30e3)));
    const h = require('crypto').createHmac('sha1', key).update(m).digest(), o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };
  // ---- one person: sign in, stream, desktop poll, page views
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2000 });
  function openStream(u) {
    if (stopping) return;
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', agent, headers: { Cookie: 'sid=' + u.token, Accept: 'text/event-stream' } }, res => {
      if (res.statusCode !== 200) { counters.sseDown++; res.resume(); return setTimeout(() => openStream(u), 5000); }
      counters.sseUp++; let buf = '';
      res.on('data', c => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.*)$/m) || [])[1], data = (block.match(/^data: (.*)$/m) || [])[1];
          if (!ev) continue; counters.sseEvents++;
          if (ev === 'message' && data) { try { const d = JSON.parse(data); counters.sseMsgs++; const m = /^LT\|(\d+)\|/.exec(d.message && d.message.body || ''); if (m) delivery.push(Date.now() - Number(m[1]));
            // about one person in five has the chat page open: it fetches the new messages and marks them read
            if (u.chatOpen) { call(u, 'chat messages (after live event)', 'GET', `/api/chat/${d.conversation_id}/messages?after=${d.message.id - 1}`); call(u, 'chat mark read', 'POST', `/api/chat/${d.conversation_id}/read`, { json: { message_id: d.message.id } }); } } catch (e) { /* ignore */ } }
        }
      });
      res.on('close', () => { counters.sseUp--; counters.sseDown++; setTimeout(() => openStream(u), 2000); });
    });
    req.on('error', () => { counters.sseDown++; setTimeout(() => openStream(u), 3000); });
  }
  async function pageView(u) {
    const kind = Math.random(); const own = u.team_id ? `&team=${u.team_id}` : '';
    if (kind < 0.30) { await call(u, 'page: dashboard', 'GET', '/api/dashboard'); }
    else if (kind < 0.60) { await call(u, 'page: teams', 'GET', '/api/teams'); await Promise.all([call(u, 'page: tasks list (100)', 'GET', `/api/tasks?limit=100${own}`), call(u, 'page: projects', 'GET', '/api/projects'), call(u, 'page: users (picker list)', 'GET', '/api/users')]); }
    else if (kind < 0.72) { await call(u, 'page: tasks all teams (30 per team)', 'GET', `/api/tasks?group=team&per_group=30`); }
    else if (kind < 0.82) { await call(u, 'page: requests list (100)', 'GET', `/api/requests?limit=100${own}`); }
    else if (kind < 0.92) { const r = await call(u, 'page: chat list', 'GET', '/api/chat'); const c = (r.json() || {}).conversations; if (c && c.length) await call(u, 'page: chat messages (50)', 'GET', `/api/chat/${pick(c).id}`); }
    else { await call(u, 'page: history (100)', 'GET', '/api/history?limit=100'); }
  }
  async function person(u) {
    const l = await call(null, 'login (password + bcrypt)', 'POST', '/api/login', { json: { email: u.email, password: 'Zz-load-pass-1' }, noAuth: true });
    const b = l.json(), ck = (l.headers && l.headers.get('set-cookie') || '').match(/sid=([^;]+)/);
    if (l.status !== 200 || !ck) { counters.loginFail++; return; }
    counters.logins++; u.token = ck[1]; u.csrf = b.csrf_token; u.chatOpen = Math.random() < 0.2;
    if (b.must_setup_2fa) { const st = (await call(u, '(setup) two-step: start', 'POST', '/api/me/2fa/setup', { json: {} })).json();
      if (st && st.secret) await call(u, '(setup) two-step: confirm', 'POST', '/api/me/2fa/enable', { json: { code: totp(st.secret) } }); }
    openStream(u);
    // the desktop app: /api/my-summary once a minute (random phase), never counted as activity
    (async () => { await sleep(rnd(0, 60e3)); while (!stopping) { await call(u, 'desktop: /api/my-summary', 'GET', '/api/my-summary'); await sleep(60e3); } })();
    // someone at the web app, a page about every two minutes
    (async () => { await sleep(rnd(2e3, 120e3)); while (!stopping) { await pageView(u); await sleep(rnd(60e3, 180e3)); } })();
    people.byId = people.byId || new Map(); people.byId.set(u.id, u);
  }

  // ---- company-wide events (Poisson arrivals) from the end of the login storm
  const live = () => people.filter(u => u.token);
  function every(perSecond, fn) { const go = async () => { while (!stopping) { await sleep(-Math.log(1 - Math.random()) / (perSecond * scale) * 1000); if (since() < STORM_MS || stopping) continue; fn().catch(() => {}); } }; go(); }
  const chatTarget = u => { const c = convs.get(u.id); return c && c.length ? pick(c) : null; };
  let seq = 0; const used = new Set();
  every(3, async () => { const u = pick(live()), c = chatTarget(u); if (!c) return; await call(u, 'chat: send message', 'POST', `/api/chat/${c}/messages`, { json: { body: `LT|${Date.now()}|${++seq} hello from the load test` } }); });
  every(1, async () => { // a small file (20-150 KB of random bytes), through the virus scanner and encryption
    const u = pick(live()), c = chatTarget(u); if (!c) return; const f = new FormData(); f.append('body', `LT|${Date.now()}|${++seq}`); f.append('files', new Blob([require('crypto').randomBytes(Math.floor(rnd(20, 150) * 1024))]), `load-${seq}.bin`);
    await call(u, 'chat: send message with a file (20-150 KB)', 'POST', `/api/chat/${c}/messages`, { form: f }); });
  every(2, async () => { const u = pick(live().filter(x => tasksOf.get(x.id))); if (!u) return; const t = pick(tasksOf.get(u.id));
    await call(u, 'task: post an update', 'POST', `/api/tasks/${t.id}/updates`, { json: { message: 'working on it', progress: Math.floor(rnd(5, 90)), status: 'in_progress' } }); });
  every(0.3, async () => { const l = pick(live().filter(x => x.role === 'lead' && teamMembers(x).length)); if (!l) return; const to = pick(teamMembers(l));
    await call(l, 'task: assign a new task', 'POST', '/api/tasks', { json: { title: `Load test task ${++seq}`, description: 'created by the load test', assignee_ids: [to.id], priority: 'medium' } }); });
  every(0.3, async () => { const u = pick(live().filter(x => (tasksOf.get(x.id) || []).some(t => t.status === 'in_progress' && !used.has(t.id)))); if (!u) return; const t = tasksOf.get(u.id).find(x => x.status === 'in_progress' && !used.has(x.id)); used.add(t.id);
    await call(u, 'task: submit for approval', 'POST', `/api/tasks/${t.id}/submit`, { json: { note: 'done, please check' } }); });
  every(0.1, async () => { const a = pick(admins.filter(x => x.token)); if (!a) return; const k = Math.random();
    if (k < 0.4) await call(a, 'admin: audit log page', 'GET', '/api/audit');
    else if (k < 0.8) await call(a, 'admin: All people page (50)', 'GET', `/api/users?paged=1&limit=50&offset=${Math.floor(rnd(0, 550))}`);
    else await call(a, 'admin: History CSV export', 'GET', '/api/history?format=csv&status=completed'); });

  // ---- samplers: probes, resources, safety stops
  const probe = { test: [], live: [] }, samples = [];
  const probeLoop = async (target, label, every_ms, url0) => { while (!stopping) { const t = performance.now(); try { const r = await fetch(url0 + '/api/version'); await r.text(); probe[target].push([since(), performance.now() - t]); } catch (e) { probe[target].push([since(), 99999]); } await sleep(every_ms); } };
  const readMem = () => { const m = fs.readFileSync('/proc/meminfo', 'utf8'); return Number((m.match(/MemAvailable:\s+(\d+)/) || [])[1]) * 1024; };
  const freeDisk = () => { const s = fs.statfsSync('/'); return s.bavail * s.bsize; };
  const GB = 1073741824;
  (async () => { while (!stopping) { if (readMem() < 1 * GB) stop(`free memory fell below 1 GB (${(readMem() / GB).toFixed(2)} GB)`); if (freeDisk() < 5 * GB) stop(`free disk fell below 5 GB (${(freeDisk() / GB).toFixed(2)} GB)`); await sleep(5000); } })();
  const rssOf = (c, cmd) => { const t = docker('exec', c, 'sh', '-c', cmd); const m = t.split('\n').map(x => Number((x.match(/VmRSS:\s+(\d+)/) || [])[1])).filter(Boolean); return m.length ? Math.max(...m) * 1024 : NaN; };
  const cpuTicks = c => { const t = docker('exec', c, 'cat', '/proc/1/stat').split(') ')[1]; if (!t) return NaN; const f = t.split(' '); return Number(f[11]) + Number(f[12]); }; // utime + stime of the main process
  let last = { t: performance.now(), ticks: cpuTicks(ctr) };
  (async () => { while (!stopping) { await sleep(10000);
    const st = Object.fromEntries(docker('stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}', ctr, 'taskdesk', 'taskdesk-clamav').split('\n').filter(Boolean).map(l => { const [n, c, m] = l.split('|'); return [n, { cpu: parseFloat(c), mem: m.split(' / ')[0] }]; }));
    const now = performance.now(), ticks = cpuTicks(ctr), mainCpu = (ticks - last.ticks) / 100 / ((now - last.t) / 1000) * 100; last = { t: now, ticks };
    samples.push({ t: since() / 1000, app_cpu: st[ctr] && st[ctr].cpu, main_thread_cpu: mainCpu, app_mem: st[ctr] && st[ctr].mem, app_rss: rssOf(ctr, 'cat /proc/1/status'), clamd_rss: rssOf('taskdesk-clamav', 'for p in $(pidof clamd); do cat /proc/$p/status; done'), clam_cpu: st['taskdesk-clamav'] && st['taskdesk-clamav'].cpu,
      live_cpu: st.taskdesk && st.taskdesk.cpu, live_mem: st.taskdesk && st.taskdesk.mem, host_avail: readMem(), disk_free: freeDisk(), db: dbBytes(), sse: counters.sseUp });
    const x = samples[samples.length - 1]; process.stdout.write(`\r[${Math.round(x.t)}s] streams ${counters.sseUp}  app cpu ${isNaN(x.app_cpu) ? '?' : x.app_cpu.toFixed(0)}%  rss ${isNaN(x.app_rss) ? '?' : Math.round(x.app_rss / 1048576)} MB  mem free ${(x.host_avail / GB).toFixed(1)} GB   `);
  } })();
  probeLoop('test', 'test server', 1000, base); probeLoop('live', 'live server', 10000, LIVE);

  // ---- go: the 600 sign-ins are spread over the first minute
  console.log(`load test: ${people.length} people, ${minutes} min, scale ${scale}, against ${base} (container ${ctr}); live server only gets a /api/version probe every 10 s`);
  await Promise.all(people.map(async u => { await sleep(rnd(0, STORM_MS - 5000)); if (!stopping) await person(u); }));
  while (!stopping && Date.now() < END) await sleep(1000);
  stop(stopping || 'finished');
  await sleep(1500); agent.destroy();

  // ---- report
  const steadyFrom = STORM_MS + 10e3, ms = v => isNaN(v) ? '-' : v < 10 ? v.toFixed(1) : String(Math.round(v));
  const rows = Object.entries(lat).sort((a, b) => b[1].length - a[1].length).map(([label, arr]) => { const all = arr.map(x => x[1]), steady = arr.filter(x => x[0] >= steadyFrom).map(x => x[1]);
    return { label, n: arr.length, errors: (errs[label] || {}).n || 0, p50: pct(all, 50), p95: pct(all, 95), max: Math.max(...all), steady_p50: pct(steady, 50), steady_p95: pct(steady, 95), error_kinds: (errs[label] || {}).sample }; });
  const pad = (s, n) => String(s).padEnd(n), rp = (s, n) => String(s).padStart(n);
  console.log('\n\n=== response times (ms): all = whole run, steady = after the login storm ===');
  console.log(pad('request', 46) + rp('count', 8) + rp('errors', 8) + rp('p50', 7) + rp('p95', 8) + rp('max', 8) + rp('steady p50', 12) + rp('steady p95', 12));
  for (const r of rows) console.log(pad(r.label, 46) + rp(r.n, 8) + rp(r.errors, 8) + rp(ms(r.p50), 7) + rp(ms(r.p95), 8) + rp(ms(r.max), 8) + rp(ms(r.steady_p50), 12) + rp(ms(r.steady_p95), 12));
  const tot = rows.reduce((a, r) => a + r.n, 0), eTot = rows.reduce((a, r) => a + r.errors, 0);
  console.log(`total requests ${tot}, errors ${eTot}${eTot ? '  ' + JSON.stringify(Object.fromEntries(rows.filter(r => r.errors).map(r => [r.label, r.error_kinds]))) : ''}`);
  const pr = (n, a) => `${n}: p50 ${ms(pct(a.map(x => x[1]), 50))} ms, p95 ${ms(pct(a.map(x => x[1]), 95))} ms, max ${ms(Math.max(...a.map(x => x[1])))} ms (${a.length} probes)`;
  const during = a => a.filter(x => x[0] < STORM_MS + 5000);
  console.log('\n=== is the server still responsive? (GET /api/version) ===');
  console.log('  test server, whole run  - ' + pr('', probe.test)); console.log('  test server, login storm - ' + pr('', during(probe.test))); console.log('  test server, steady      - ' + pr('', probe.test.filter(x => x[0] >= steadyFrom)));
  console.log('  LIVE server (10 s probes) - ' + pr('', probe.live));
  console.log(`\n=== live streams: ${counters.logins} signed in, ${counters.loginFail} sign-in failures, up now ${counters.sseUp}, dropped/reconnected ${counters.sseDown}, ${counters.sseEvents} events received (${counters.sseMsgs} chat messages)`);
  if (delivery.length) console.log(`    chat message delivery to a member's open stream: p50 ${ms(pct(delivery, 50))} ms, p95 ${ms(pct(delivery, 95))} ms, max ${ms(Math.max(...delivery))} ms (${delivery.length} deliveries)`);
  const col = k => samples.map(x => x[k]).filter(v => v !== undefined && !isNaN(v)), mb = v => Math.round(v / 1048576);
  const steady = samples.filter(x => x.t >= steadyFrom / 1000);
  console.log('\n=== resources (sampled every 10 s) ===');
  console.log(`  test app: cpu (docker, 100% = one core) avg ${(col('app_cpu').reduce((a, b) => a + b, 0) / Math.max(1, col('app_cpu').length)).toFixed(0)}% max ${Math.max(...col('app_cpu')).toFixed(0)}%; main thread avg ${(col('main_thread_cpu').reduce((a, b) => a + b, 0) / Math.max(1, col('main_thread_cpu').length)).toFixed(0)}% max ${Math.max(...col('main_thread_cpu')).toFixed(0)}%; steady avg ${(steady.reduce((a, x) => a + (x.app_cpu || 0), 0) / Math.max(1, steady.length)).toFixed(0)}%`);
  console.log(`  test app memory: rss max ${mb(Math.max(...col('app_rss')))} MB, end ${mb(col('app_rss').slice(-1)[0])} MB; container (cgroup) max ${[...new Set(col('app_mem'))].slice(-1)[0]}`);
  console.log(`  ClamAV (shared with live): clamd rss max ${mb(Math.max(...col('clamd_rss')))} MB; cpu avg ${(col('clam_cpu').reduce((a, b) => a + b, 0) / Math.max(1, col('clam_cpu').length)).toFixed(1)}% max ${Math.max(...col('clam_cpu')).toFixed(0)}%`);
  console.log(`  live app during the test: cpu max ${Math.max(...col('live_cpu')).toFixed(1)}%`);
  console.log(`  host: available memory min ${(Math.min(...col('host_avail')) / GB).toFixed(2)} GB, free disk min ${(Math.min(...col('disk_free')) / GB).toFixed(1)} GB`);
  const dbEnd = dbBytes(), upEnd = (() => { try { return fs.readdirSync(path.join(dir, 'uploads')).length; } catch (e) { return 0; } })();
  console.log(`  database (db + wal): ${(dbStart / 1048576).toFixed(1)} MB -> ${(dbEnd / 1048576).toFixed(1)} MB (+${((dbEnd - dbStart) / 1048576).toFixed(1)} MB in ${minutes} min); uploaded files ${upBytes0} -> ${upEnd}`);
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify({ minutes, scale, rows, counters, probe: { test: probe.test.length, live: probe.live.length }, samples, delivery_p50: pct(delivery, 50), delivery_p95: pct(delivery, 95), stopped: stopping }, null, 1));
  process.exit(/finished/.test(stopping) ? 0 : 3);
}

if (mode === 'seed') seed();
else if (mode === 'run') run().catch(e => { console.error('load test crashed:', e); process.exit(2); });
else die('usage: node scripts/loadtest.js seed --data <copy folder>   |   run --url <copy server> --data <copy folder> --container <name> [--minutes 10]');

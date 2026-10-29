const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'taskdesk.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  lead_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','closed')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','submitted','completed')),
  progress INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  deadline TEXT,
  completed_at TEXT,
  submitted_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS task_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  progress INTEGER,
  status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_updates_task ON task_updates(task_id);
`);

// ---- Approval step: allow status 'submitted' and add submitted_at / approved_by ----
// SQLite can't alter a CHECK constraint, so an old tasks table is rebuilt once, inside one transaction.
// A snapshot of the database is saved next to it first, and the row count is verified before committing.
(function migrateTasksForApproval() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  if (!row || row.sql.includes("'submitted'")) return;
  console.log('Upgrading tasks table for the approval step...');
  const snapshot = path.join(dataDir, 'taskdesk-before-approval-migration.db');
  if (!fs.existsSync(snapshot)) db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  const keep = ['id','title','description','project_id','assignee_id','assigned_by','priority','status','progress',
    'start_date','deadline','completed_at','created_at','updated_at'];
  const missing = keep.filter(c => !cols.includes(c));
  if (missing.length) throw new Error('Unexpected tasks table, missing columns: ' + missing.join(', '));
  const list = keep.join(', ');
  db.pragma('foreign_keys = OFF'); // must be off while the table is swapped; checked again before commit
  try {
    db.transaction(() => {
      const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
      db.exec(`
        CREATE TABLE tasks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          assignee_id INTEGER NOT NULL REFERENCES users(id),
          assigned_by INTEGER NOT NULL REFERENCES users(id),
          priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
          status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','submitted','completed')),
          progress INTEGER NOT NULL DEFAULT 0,
          start_date TEXT,
          deadline TEXT,
          completed_at TEXT,
          submitted_at TEXT,
          approved_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO tasks_new (${list}) SELECT ${list} FROM tasks;`);
      const copied = db.prepare('SELECT COUNT(*) AS n FROM tasks_new').get().n;
      if (copied !== before) throw new Error(`Row count mismatch (${before} before, ${copied} after); nothing was changed.`);
      db.exec(`
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);`);
      const after = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
      if (after !== before) throw new Error('Row count changed during upgrade; rolled back.');
      if (db.pragma('foreign_key_check').length) throw new Error('Foreign key check failed; rolled back.');
      console.log(`tasks table upgraded: ${after} rows kept.`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
})();

// ---- Teams, document requests and file attachments (additive: new tables and columns only) ----
(function addTeamsRequestsFiles() {
  const hadTeams = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='teams'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      lead_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'team_id')) {
    db.exec('ALTER TABLE users ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL');
  }
  if (!hadTeams) { // starting teams, created once
    const ins = db.prepare('INSERT INTO teams (name) VALUES (?)');
    for (const n of ['R&D', 'Testing', 'STQC Documentation']) ins.run(n);
  }
  // requests.status is validated in server.js (no CHECK constraint) so new statuses never need a table rebuild.
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      needed_by TEXT,
      requested_by INTEGER NOT NULL REFERENCES users(id),
      target_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open',
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_team ON requests(target_team_id);
    CREATE INDEX IF NOT EXISTS idx_requests_by ON requests(requested_by);
    CREATE INDEX IF NOT EXISTS idx_requests_task ON requests(task_id);
    CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL DEFAULT '',
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES task_updates(id) ON DELETE SET NULL,
      request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS request_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_request_events_request ON request_events(request_id);
    CREATE INDEX IF NOT EXISTS idx_files_task ON files(task_id);
    CREATE INDEX IF NOT EXISTS idx_files_request ON files(request_id);`);
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  // When the "still unassigned after 24 hours" reminder went out (once per request).
  if (!db.prepare('PRAGMA table_info(requests)').all().some(c => c.name === 'reminded_at')) {
    db.exec('ALTER TABLE requests ADD COLUMN reminded_at TEXT');
  }
  // Ask a person: the person the request was sent to (cleared when they give it back). Withdraw: who had it then.
  const reqCols = db.prepare('PRAGMA table_info(requests)').all().map(c => c.name);
  if (!reqCols.includes('asked_person_id')) db.exec('ALTER TABLE requests ADD COLUMN asked_person_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  if (!reqCols.includes('withdrawn_from_id')) db.exec('ALTER TABLE requests ADD COLUMN withdrawn_from_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  // Archive instead of delete: Delete / Give back / Withdraw set deleted_at + deleted_by; rows and files stay until a
  // manager deletes them permanently from History. archived_request_id: the request an archived task came from (for Restore).
  for (const table of ['tasks', 'requests']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes('deleted_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
    if (!cols.includes('deleted_by')) db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  }
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'archived_request_id'))
    db.exec('ALTER TABLE tasks ADD COLUMN archived_request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL');
  // Teams that work together: their members may send requests to each other. Two-way, each pair once (smaller id first).
  db.exec(`CREATE TABLE IF NOT EXISTS team_connections (
      team_a_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      team_b_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_a_id, team_b_id),
      CHECK (team_a_id < team_b_id)
    )`);
  // Chat: direct (one per pair of people), group and team conversations (one per team, members kept in sync by server.js).
  // Only members can read a conversation. archived_at: the team was deleted; members can still read it, nobody can post.
  db.exec(`CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_message_at TEXT,
      archived_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_team ON conversations(team_id) WHERE type = 'team';
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      edited_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);`);
  if (!db.prepare('PRAGMA table_info(files)').all().some(c => c.name === 'message_id'))
    db.exec('ALTER TABLE files ADD COLUMN message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_id)');
  // Several leads per team, all equal. teams.lead_id stays (kept equal to the first lead by server.js) but no check uses it.
  // When the table is first created, every existing teams.lead_id is copied into it once.
  const hadLeads = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_leads'`).get();
  db.exec(`CREATE TABLE IF NOT EXISTS team_leads (
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_team_leads_user ON team_leads(user_id);`);
  if (!hadLeads) db.exec('INSERT OR IGNORE INTO team_leads (team_id, user_id) SELECT id, lead_id FROM teams WHERE lead_id IS NOT NULL');
  // Projects can belong to one or more teams (set by managers/admins). Nothing is seeded: existing projects have no team.
  db.exec(`CREATE TABLE IF NOT EXISTS project_teams (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, team_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_teams_team ON project_teams(team_id);`);
  // "Remove person" (admins): someone with history is kept but marked removed; their email is freed (original_email).
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('removed_at')) db.exec('ALTER TABLE users ADD COLUMN removed_at TEXT');
  if (!userCols.includes('removed_by')) db.exec('ALTER TABLE users ADD COLUMN removed_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  if (!userCols.includes('original_email')) db.exec('ALTER TABLE users ADD COLUMN original_email TEXT');
  // Email: one-time "Set your password" links (welcome 48 h, reset 1 h; only the SHA-256 of the token is stored)
  // and the optional notification emails each person turns on (all off by default).
  db.exec(`CREATE TABLE IF NOT EXISTS password_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_password_tokens_user ON password_tokens(user_id);`);
  for (const c of ['email_assigned', 'email_approval', 'email_ready', 'email_unassigned', 'email_notes'])
    if (!userCols.includes(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
  // Team managers: a person with role "team_manager" manages one or more teams (set by managers/admins).
  db.exec(`CREATE TABLE IF NOT EXISTS team_managers (
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_team_managers_user ON team_managers(user_id);`);
  // Assignment groups: the copies of a task assigned to several people at once share assignment_group_id (the first
  // copy's id; no foreign key, so deleting that copy leaves the group intact). Older tasks keep it empty.
  // Files given to a whole group are stored once (files.task_id NULL) and linked to each copy in task_files.
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'assignment_group_id'))
    db.exec('ALTER TABLE tasks ADD COLUMN assignment_group_id INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(assignment_group_id);
    CREATE TABLE IF NOT EXISTS task_files (
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES task_updates(id) ON DELETE SET NULL,
      PRIMARY KEY (file_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files(task_id);`);
  // note_kind: 'note' or 'files' on an update someone posted with a note or files (for "new note" notifications);
  // empty on status-only updates and on older rows.
  if (!db.prepare('PRAGMA table_info(task_updates)').all().some(c => c.name === 'note_kind'))
    db.exec('ALTER TABLE task_updates ADD COLUMN note_kind TEXT');
  // Protected accounts: can't be removed, deactivated or given a lower role (only the owner turns it on/off).
  // Deepith Jain is protected once, when the column is added; a later "off" by the owner is never undone.
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'protected')) db.transaction(() => {
    db.exec('ALTER TABLE users ADD COLUMN protected INTEGER NOT NULL DEFAULT 0');
    const n = db.prepare(`UPDATE users SET protected = 1 WHERE email = 'deepith@hifocuscctv.com'`).run().changes;
    console.log(`[db] added users.protected; protected ${n} account(s) (deepith@hifocuscctv.com)`);
  })();
  // A person's account activity: protection changes, refused changes, owner transfers (who, what, when).
  // app_settings: small server values, e.g. the last known owner (to notice and record a transfer at startup).
  db.exec(`CREATE TABLE IF NOT EXISTS account_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_account_events_user ON account_events(user_id);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);`);
})();

// ---- Roles: users.role has no CHECK constraint any more (server.js validates it on every write) ----
// The old table only allowed four roles, and SQLite can't alter a CHECK, so it is rebuilt once like the tasks table:
// snapshot first, every column copied inside one transaction, row count and foreign keys verified before committing.
(function migrateUsersRoleCheck() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!row || !/CHECK\s*\(\s*role IN/i.test(row.sql)) return;
  console.log('Upgrading users table (role check moves to the server)...');
  const snapshot = path.join(dataDir, 'taskdesk-before-team-manager-migration.db');
  if (!fs.existsSync(snapshot)) db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  const sql = row.sql.replace(/\s*CHECK\s*\(\s*role IN\s*\([^)]*\)\s*\)/i, '').replace(/^CREATE TABLE\s+"?users"?/i, 'CREATE TABLE users_new');
  if (/CHECK\s*\(\s*role/i.test(sql) || !/^CREATE TABLE users_new/.test(sql)) throw new Error('Unexpected users table definition; nothing was changed.');
  const list = db.prepare('PRAGMA table_info(users)').all().map(c => c.name).join(', ');
  db.pragma('foreign_keys = OFF'); // must be off while the table is swapped; checked again before commit
  try {
    db.transaction(() => {
      const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      const seq = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'users'`).get(); // ids of deleted people are never reused
      db.exec(`${sql}; INSERT INTO users_new (${list}) SELECT ${list} FROM users;`);
      const copied = db.prepare('SELECT COUNT(*) AS n FROM users_new').get().n;
      if (copied !== before) throw new Error(`Row count mismatch (${before} before, ${copied} after); nothing was changed.`);
      db.exec(`DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);`);
      if (seq) db.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'users'`).run(seq.seq);
      const after = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      if (after !== before) throw new Error('Row count changed during upgrade; rolled back.');
      if (db.pragma('foreign_key_check').length) throw new Error('Foreign key check failed; rolled back.');
      console.log(`users table upgraded: ${after} rows kept.`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
})();

// Teams a person leads or manages (one row per team and person). A TEMP view: it lives only in this connection,
// nothing is stored in the database file.
db.exec(`CREATE TEMP VIEW IF NOT EXISTS team_powers AS
  SELECT team_id, user_id FROM main.team_leads UNION SELECT team_id, user_id FROM main.team_managers`);

// Create the first admin account if there are no users yet.
const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (count === 0) {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const name = process.env.ADMIN_NAME || 'Administrator';
  db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)')
    .run(name, email, bcrypt.hashSync(password, 10), 'admin');
  console.log(`Created admin account: ${email}`);
  if (!process.env.ADMIN_PASSWORD) console.log('Default password in use — sign in and change it now.');
}

module.exports = db;

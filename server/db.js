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
  role TEXT NOT NULL CHECK (role IN ('admin','manager','lead','employee')),
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
})();

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

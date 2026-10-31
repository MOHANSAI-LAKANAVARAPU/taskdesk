// Encrypted database (Security A2). data/taskdesk.db is an SQLCipher 4 database (better-sqlite3-multiple-ciphers,
// cipher 'sqlcipher', legacy=4: AES-256-CBC pages with HMAC-SHA512), keyed with a raw 256-bit key derived from
// master.key. Every program that opens the database (server, scripts/backup.sh, transfer-owner.sh, checks) goes
// through openDb(), so the key handling lives only here. A plain (unencrypted) database file is refused.
//
// Copies: SQLite's backup API can't write an encrypted copy here (it refuses an unkeyed target) and VACUUM INTO would
// write a plain one, so exportCopy() builds the copy itself: a new keyed database, the schema from sqlite_master, then
// every row, all read inside one read transaction (a consistent snapshot while the server keeps running).
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3-multiple-ciphers');
const keys = require('./keys');

let keyHex = null;
const dbKey = () => keyHex || (keyHex = keys.derive(keys.readKey('master.key'), 'database').toString('hex'));
function applyKey(db) {
  db.pragma(`cipher='sqlcipher'`);
  db.pragma('legacy=4');
  db.pragma(`key="x'${dbKey()}'"`);
}

const SQLITE_HEADER = 'SQLite format 3\0';
function isPlainSqlite(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16); return fs.readSync(fd, b, 0, 16, 0) === 16 && b.toString('latin1') === SQLITE_HEADER; }
  catch (e) { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Opens the encrypted database (creating a new encrypted one if the file doesn't exist, unless fileMustExist).
function openDb(file, opts = {}) {
  if (isPlainSqlite(file)) throw new Error(`${file} is not encrypted. Convert it first with scripts/encrypt-db.js (server stopped).`);
  const db = new Database(file, opts);
  applyKey(db);
  try { db.prepare('SELECT COUNT(*) FROM sqlite_master').get(); }
  catch (e) { db.close(); throw new Error(`${file} can't be opened with this master.key (${e.message}). Is it the right key? See scripts/KEYS.md.`); }
  return db;
}
// A plain database, read-only (only for the one-time conversion and its checks).
const openPlain = file => new Database(file, { readonly: true, fileMustExist: true });

// Copy every table, index, trigger and view of `src` (an open connection, plain or encrypted) into a new encrypted
// database at `dest`, in one read transaction. Returns { tables: { name: rowCount } }.
function exportCopy(src, dest) {
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
  const out = openDb(dest);
  try {
    out.pragma('journal_mode = DELETE');
    out.pragma('foreign_keys = OFF');
    out.pragma(`user_version = ${src.pragma('user_version', { simple: true })}`);
    const counts = {};
    src.exec('BEGIN'); // read snapshot: everything below sees the same moment
    try {
      const schema = src.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all();
      const tables = schema.filter(s => s.type === 'table');
      out.transaction(() => {
        for (const t of tables) out.exec(t.sql);
        for (const t of tables) {
          const cols = src.prepare(`SELECT * FROM "${t.name}" LIMIT 0`).columns().map(c => c.name);
          const ins = out.prepare(`INSERT INTO "${t.name}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
          let n = 0;
          for (const row of src.prepare(`SELECT * FROM "${t.name}"`).raw().iterate()) { ins.run(row); n++; }
          counts[t.name] = n;
        }
        if (src.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'`).get()) {
          out.exec('DELETE FROM sqlite_sequence');
          const seq = out.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
          for (const r of src.prepare('SELECT name, seq FROM sqlite_sequence').all()) seq.run(r.name, r.seq);
        }
        // Indexes, views and triggers last (the audit_log triggers only refuse UPDATE/DELETE, but keep the order anyway).
        for (const s of schema.filter(x => x.type !== 'table')) out.exec(s.sql);
      })();
    } finally { src.exec('COMMIT'); }
    return { tables: counts };
  } finally { out.close(); }
}

// What must be equal between two databases: the schema, and per table the row count and a hash of every row.
function digest(db) {
  const schema = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name`).all();
  const tables = {};
  db.exec('BEGIN');
  try {
    for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all()) {
      const h = crypto.createHash('sha256'); let n = 0;
      const ordered = /WITHOUT ROWID/i.test((schema.find(s => s.name === name) || {}).sql || '') ? 'ORDER BY 1' : 'ORDER BY rowid';
      for (const row of db.prepare(`SELECT * FROM "${name}" ${name === 'sqlite_sequence' ? 'ORDER BY name' : ordered}`).raw().iterate())
        { h.update(JSON.stringify(row, (k, v) => Buffer.isBuffer(v) ? 'blob:' + v.toString('hex') : v)); h.update('\n'); n++; }
      tables[name] = { rows: n, sha256: h.digest('hex') };
    }
  } finally { db.exec('COMMIT'); }
  return { schema: crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex'), tables };
}
const health = db => ({ integrity: db.pragma('integrity_check', { simple: true }), foreign_key_problems: db.pragma('foreign_key_check').length });

module.exports = { openDb, openPlain, isPlainSqlite, exportCopy, digest, health };

// One-time conversion (Security A2): turns the plain data/taskdesk.db into an SQLCipher-encrypted database (dbfile.js).
// Run with the server stopped, inside the image (it needs master.key):
//   docker compose run --rm --no-deps -T taskdesk node scripts/encrypt-db.js
// 1. An encrypted copy is made next to it (taskdesk.db.enc-tmp) from the plain database, including its -wal.
// 2. The copy is checked: integrity, foreign keys, the same schema, and for every table the same row count and the same
//    hash over all its rows. Nothing is swapped unless everything matches.
// 3. Swap: the plain files are renamed to taskdesk.db.plain-old(-wal/-shm), the copy becomes taskdesk.db (WAL on).
// 4. The swapped-in database is opened and checked against the plain one again; only then are the plain files removed.
// Take a backup into ../backups first (the plain copy there is the way back). Exit code 0 = done and verified.
const fs = require('fs');
const path = require('path');
const dbfile = require('../dbfile');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB = path.join(DATA, 'taskdesk.db'), TMP = DB + '.enc-tmp', OLD = DB + '.plain-old';
const log = m => console.log('[encrypt-db] ' + m);
const fail = m => { console.error('[encrypt-db] FAILED: ' + m); process.exit(1); };
function same(a, b) {
  if (a.schema !== b.schema) return 'the schema differs';
  const names = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
  for (const n of names) {
    if (!a.tables[n] || !b.tables[n]) return `table ${n} is missing on one side`;
    if (a.tables[n].rows !== b.tables[n].rows) return `table ${n}: ${a.tables[n].rows} rows vs ${b.tables[n].rows}`;
    if (a.tables[n].sha256 !== b.tables[n].sha256) return `table ${n}: the rows differ`;
  }
  return null;
}
const summary = d => Object.entries(d.tables).map(([n, t]) => `${n}=${t.rows}`).join(' ');

if (!fs.existsSync(DB)) fail(`${DB} doesn't exist`);
if (!dbfile.isPlainSqlite(DB)) {
  dbfile.openDb(DB, { readonly: true, fileMustExist: true }).close(); // throws if the key doesn't fit
  log('the database is already encrypted; nothing to do'); log('OK'); process.exit(0);
}
for (const f of [TMP, TMP + '-journal']) if (fs.existsSync(f)) { fs.unlinkSync(f); log(`removed ${path.basename(f)} left by an interrupted run`); }
for (const f of [OLD, OLD + '-wal', OLD + '-shm']) if (fs.existsSync(f)) fail(`${f} exists from an earlier run; look at it before running again`);

// 1-2. Encrypted copy, checked against the plain database.
const plain = dbfile.openPlain(DB);
const before = dbfile.digest(plain), ph = dbfile.health(plain);
if (ph.integrity !== 'ok' || ph.foreign_key_problems) fail(`the plain database itself has problems (${JSON.stringify(ph)}); nothing was changed`);
dbfile.exportCopy(plain, TMP);
plain.close();
let enc = dbfile.openDb(TMP, { readonly: true, fileMustExist: true });
const eh = dbfile.health(enc), copy = dbfile.digest(enc); enc.close();
if (eh.integrity !== 'ok' || eh.foreign_key_problems) fail(`the encrypted copy failed its checks (${JSON.stringify(eh)}); nothing was swapped`);
const diff1 = same(before, copy);
if (diff1) fail(`the encrypted copy doesn't match: ${diff1}; nothing was swapped`);
if (dbfile.isPlainSqlite(TMP)) fail('the copy is not encrypted; nothing was swapped');
log(`step 1-2: encrypted copy made and checked: integrity ok, foreign keys ok, schema and every row identical (${Object.keys(before.tables).length} tables: ${summary(before)})`);

// 3. Swap.
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.renameSync(DB + s, OLD + s);
fs.renameSync(TMP, DB);
enc = dbfile.openDb(DB, { fileMustExist: true });
enc.pragma('journal_mode = WAL');
enc.close();
log('step 3: swapped in (the plain files are now taskdesk.db.plain-old*)');

// 4. Check again, then remove the plain files.
const old = dbfile.openPlain(OLD), again = dbfile.digest(old); old.close();
enc = dbfile.openDb(DB, { readonly: true, fileMustExist: true });
const fh = dbfile.health(enc), live = dbfile.digest(enc); enc.close();
const diff2 = same(again, live) || same(before, live);
if (fh.integrity !== 'ok' || fh.foreign_key_problems || diff2) fail(`the swapped-in database doesn't match (${diff2 || JSON.stringify(fh)}). The plain files are kept as taskdesk.db.plain-old*; to go back, stop and rename them to taskdesk.db*`);
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(OLD + s)) fs.unlinkSync(OLD + s);
log('step 4: the encrypted database matches the plain one again; plain files removed');
log('OK');

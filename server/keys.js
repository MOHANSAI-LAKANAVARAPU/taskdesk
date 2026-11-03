// Encryption keys (Security A2). Two random 256-bit keys in server/secrets/ (SECRETS_DIR), each stored as 64 hex characters:
// - master.key: encrypts the uploaded files and the database. The server can't start without it.
// - backup.key: encrypts the backups made by scripts/backup.sh. The server itself never uses it.
// Missing keys are created on first run (folder 700, files 600). In Docker a one-off "keys" service runs
// `node keys.js` with the folder writable, then the app gets the folder read-only. The keys are never printed or logged.
// Losing them means the data can never be recovered: see scripts/KEYS.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The folder: KEYS_DIR, else SECRETS_DIR, else ./secrets. Cloud mode (AWS prep): TASKDESK_CLOUD=true. The keys are then put in
// place by the host from Secrets Manager (a read-only mount), and this program NEVER makes keys: a missing or bad key is a
// stop with a message, because a new key would silently make the existing data unreadable.
const DIR = process.env.KEYS_DIR || process.env.SECRETS_DIR || path.join(__dirname, 'secrets');
const CLOUD = process.env.TASKDESK_CLOUD === 'true';
const NAMES = ['master.key', 'backup.key'];
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE_MAGIC = 'TDF1'; // first bytes of an encrypted upload (see filecrypt.js)

// Data that a lost master.key used to lock: an encrypted database (no plain SQLite header) or an encrypted upload.
// A new key could never read it, so master.key is then refused instead of made.
function encryptedDataExists() {
  const head = (file, n) => { try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); fs.closeSync(fd); return b.subarray(0, got); } catch (e) { return null; } };
  const db = head(path.join(DATA_DIR, 'taskdesk.db'), 16);
  if (db && db.length && db.toString('latin1') !== 'SQLite format 3\0') return 'the database';
  let names = [];
  try { names = fs.readdirSync(path.join(DATA_DIR, 'uploads')); } catch (e) { /* no uploads yet */ }
  if (names.some(n => (head(path.join(DATA_DIR, 'uploads', n), 4) || '').toString() === FILE_MAGIC)) return 'uploaded files';
  return null;
}

function cloudMissing(name) {
  return new Error(`cloud mode: ${path.join(DIR, name)} is missing or unreadable. Keys are never generated in the cloud (a new key would make the existing data unreadable). The host puts both keys in ${DIR} from Secrets Manager before the app starts; check that and the folder's group permissions.`);
}

function ensureKeys() {
  if (CLOUD) { for (const name of NAMES) readKey(name); return []; } // checks only; makes nothing
  const made = [];
  if (!fs.existsSync(path.join(DIR, 'master.key'))) {
    const what = encryptedDataExists();
    if (what) throw Object.assign(new Error(`master.key is missing, but data in ${DATA_DIR} (${what}) is encrypted with it. A new key couldn't read it, so none was made. Put back your copy from the USB drive (scripts/KEYS.md).`), { refused: true });
  }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DIR, 0o700);
  for (const name of NAMES) {
    const file = path.join(DIR, name);
    if (fs.existsSync(file)) continue;
    // 'wx' never overwrites a key that appeared in the meantime.
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    made.push(name);
  }
  for (const name of NAMES) fs.chmodSync(path.join(DIR, name), 0o600);
  return made;
}

function readKey(name) {
  const file = path.join(DIR, name);
  let text;
  try { text = fs.readFileSync(file, 'utf8').trim(); }
  catch (e) { if (CLOUD) throw cloudMissing(name); throw new Error(`${file} is missing or unreadable (${e.code}). Create the keys with \`node keys.js\` (Docker: \`docker compose up -d\` runs it), or put back your copy from the USB drive (scripts/KEYS.md).`); }
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${file} is not a valid key (expected 64 hex characters).`);
  return Buffer.from(text, 'hex');
}

// The server: load master.key, creating the keys first when they're missing and the folder can be written.
function loadMasterKey() {
  if (!CLOUD && !fs.existsSync(path.join(DIR, 'master.key'))) {
    try { const made = ensureKeys(); if (made.length) console.log(`[keys] created ${made.join(' and ')} in ${DIR}. Copy them to a USB drive now (scripts/KEYS.md).`); }
    catch (e) { if (e.refused) throw e; /* read-only folder: readKey explains */ }
  }
  return readKey('master.key');
}

// Separate keys for separate uses, derived from master.key (HKDF-SHA256), so one key never serves two purposes.
const derive = (master, purpose) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'taskdesk ' + purpose, 32));

module.exports = { DIR, ensureKeys, readKey, loadMasterKey, derive };

if (require.main === module) {
  try {
    const made = ensureKeys();
    for (const n of NAMES) readKey(n);
    console.log(made.length ? `[keys] created ${made.join(' and ')} in ${DIR}. Copy them to a USB drive now (scripts/KEYS.md).` : `[keys] ${NAMES.join(' and ')} present in ${DIR}`);
  } catch (e) { console.error('[keys] ' + e.message); process.exit(1); }
}

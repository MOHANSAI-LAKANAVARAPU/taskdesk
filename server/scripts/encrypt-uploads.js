// One-time conversion (Security A2): encrypts every plain file in data/uploads/ with filecrypt.js. Run with the server
// stopped, inside the image (it needs master.key):
//   docker compose run --rm --no-deps taskdesk node scripts/encrypt-uploads.js
// 1. Each plain file is encrypted to "<name>.enc-tmp" and that copy is decrypted again: it must give the same bytes
//    (SHA-256 and size). Nothing is replaced unless every file passes.
// 2. Each checked copy replaces its plain file (rename, so the plain copy is gone in the same step).
// 3. Everything is checked again: every file is encrypted and decrypts to the bytes recorded in step 1, the file count
//    is unchanged, and every files row has its file with the recorded size.
// Files already encrypted are left alone, so it is safe to run again. Exit code 0 = all done and verified.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const keys = require('../keys');
const filecrypt = require('../filecrypt');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UP = path.join(DATA, 'uploads');
const fail = msg => { console.error('[encrypt-uploads] FAILED: ' + msg); process.exit(1); };
const sha = file => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('error', rej).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))); });

(async () => {
  filecrypt.init(keys.readKey('master.key'));
  const names = fs.readdirSync(UP).filter(n => fs.statSync(path.join(UP, n)).isFile());
  const stray = names.filter(n => n.endsWith('.enc-tmp'));
  for (const n of stray) fs.unlinkSync(path.join(UP, n)); // left by an interrupted run; the plain file is still there
  const files = names.filter(n => !n.endsWith('.enc-tmp'));
  const plain = files.filter(n => !filecrypt.isEncrypted(path.join(UP, n)));
  console.log(`[encrypt-uploads] ${files.length} files in ${UP}: ${plain.length} to encrypt, ${files.length - plain.length} already encrypted`);

  // 1. Encrypt to a temporary copy and check it decrypts to the same bytes.
  const want = {};
  for (const n of plain) {
    const src = path.join(UP, n), tmp = src + '.enc-tmp';
    want[n] = { sha256: await sha(src), size: fs.statSync(src).size };
    await pipeline(fs.createReadStream(src), filecrypt.encryptStream(), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
    const got = await filecrypt.decryptedDigest(tmp);
    if (got.sha256 !== want[n].sha256 || got.size !== want[n].size) fail(`${n}: the encrypted copy doesn't decrypt to the same bytes; nothing was replaced`);
  }
  console.log(`[encrypt-uploads] step 1: ${plain.length} encrypted copies made and each decrypts to identical bytes`);

  // 2. Replace each plain file with its checked copy.
  for (const n of plain) fs.renameSync(path.join(UP, n + '.enc-tmp'), path.join(UP, n));
  const dfd = fs.openSync(UP, 'r'); fs.fsyncSync(dfd); fs.closeSync(dfd);
  console.log(`[encrypt-uploads] step 2: ${plain.length} plain files replaced by their encrypted copies`);

  // 3. Check everything again.
  const after = fs.readdirSync(UP).filter(n => fs.statSync(path.join(UP, n)).isFile());
  if (after.length !== files.length) fail(`file count changed: ${files.length} before, ${after.length} after`);
  const sizes = {};
  for (const n of after) {
    const f = path.join(UP, n);
    if (!filecrypt.isEncrypted(f)) fail(`${n} is not encrypted`);
    const got = await filecrypt.decryptedDigest(f);
    if (want[n] && (got.sha256 !== want[n].sha256 || got.size !== want[n].size)) fail(`${n} doesn't decrypt to its original bytes`);
    sizes[n] = got.size;
  }
  const Database = require('better-sqlite3'); // read-only, just the file list
  const db = new Database(path.join(DATA, 'taskdesk.db'), { readonly: true, fileMustExist: true });
  const rows = db.prepare('SELECT stored_name, size FROM files').all(); db.close();
  const missing = rows.filter(r => sizes[r.stored_name] === undefined), wrong = rows.filter(r => sizes[r.stored_name] !== undefined && sizes[r.stored_name] !== r.size);
  if (missing.length) fail(`${missing.length} files rows have no file: ${missing.slice(0, 5).map(r => r.stored_name).join(', ')}`);
  if (wrong.length) fail(`${wrong.length} files decrypt to a size other than the files row says: ${wrong.slice(0, 5).map(r => r.stored_name).join(', ')}`);
  console.log(`[encrypt-uploads] step 3: all ${after.length} files are encrypted and decrypt correctly (${plain.length} compared byte for byte with the originals); all ${rows.length} files rows have their file with the right size`);
  console.log('[encrypt-uploads] OK');
})().catch(e => fail(e.message));

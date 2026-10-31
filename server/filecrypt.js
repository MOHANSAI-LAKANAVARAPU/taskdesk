// Encrypted uploads (Security A2). Every file in data/uploads/ is stored as:
//   "TDF1" | wrapped file key (12-byte IV, 32-byte key, 16-byte tag) | 8-byte nonce prefix | chunks
// The file key is random per file and wrapped (AES-256-GCM) with a key derived from master.key. The content is cut into
// 64 KiB chunks, each AES-256-GCM encrypted with IV = nonce prefix + chunk number and its own 16-byte tag; the last
// chunk is marked (additional data 1, others 0), so a reordered, changed or cut-off file fails to decrypt. Chunks let
// downloads decrypt as they stream, without holding the whole file in memory.
const fs = require('fs');
const crypto = require('crypto');
const { Transform } = require('stream');

const MAGIC = Buffer.from('TDF1');
const CHUNK = 64 * 1024, TAG = 16, HEADER = 4 + 12 + 32 + 16 + 8;
const LAST = Buffer.from([1]), MORE = Buffer.from([0]);

let KEK = null; // set once by init(master key)
function init(masterKey) { KEK = require('./keys').derive(masterKey, 'upload file keys'); }

const chunkIv = (prefix, n) => { const iv = Buffer.alloc(12); prefix.copy(iv, 0); iv.writeUInt32BE(n, 8); return iv; };
function sealChunk(key, prefix, n, data, last) {
  const c = crypto.createCipheriv('aes-256-gcm', key, chunkIv(prefix, n)); c.setAAD(last ? LAST : MORE);
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}
function openChunk(key, prefix, n, rec, last) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, chunkIv(prefix, n)); d.setAAD(last ? LAST : MORE);
  d.setAuthTag(rec.subarray(rec.length - TAG));
  return Buffer.concat([d.update(rec.subarray(0, rec.length - TAG)), d.final()]);
}
function header() {
  if (!KEK) throw new Error('filecrypt not initialised');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), prefix = crypto.randomBytes(8);
  const c = crypto.createCipheriv('aes-256-gcm', KEK, iv); c.setAAD(MAGIC);
  const wrapped = Buffer.concat([c.update(key), c.final()]);
  return { key, prefix, bytes: Buffer.concat([MAGIC, iv, wrapped, c.getAuthTag(), prefix]) };
}
function parseHeader(h) {
  if (!KEK) throw new Error('filecrypt not initialised');
  if (h.length < HEADER || !h.subarray(0, 4).equals(MAGIC)) throw new Error('not an encrypted TaskDesk file');
  const d = crypto.createDecipheriv('aes-256-gcm', KEK, h.subarray(4, 16)); d.setAAD(MAGIC);
  d.setAuthTag(h.subarray(48, 64));
  return { key: Buffer.concat([d.update(h.subarray(16, 48)), d.final()]), prefix: h.subarray(64, 72) };
}

// Plain bytes in, encrypted file bytes out.
function encryptStream() {
  const h = header(); let buf = Buffer.alloc(0), n = 0, started = false;
  return new Transform({
    transform(data, enc, cb) {
      if (!started) { this.push(h.bytes); started = true; }
      buf = Buffer.concat([buf, data]);
      // Keep at least one byte back, so the last chunk is only written (and marked) at the end.
      while (buf.length > CHUNK) { this.push(sealChunk(h.key, h.prefix, n++, buf.subarray(0, CHUNK), false)); buf = buf.subarray(CHUNK); }
      cb();
    },
    flush(cb) {
      if (!started) this.push(h.bytes);
      this.push(sealChunk(h.key, h.prefix, n, buf, true));
      cb();
    }
  });
}
// Encrypted file bytes in, plain bytes out. Any change, cut or wrong key ends the stream with an error.
function decryptStream() {
  let buf = Buffer.alloc(0), h = null, n = 0;
  const REC = CHUNK + TAG;
  return new Transform({
    transform(data, enc, cb) {
      try {
        buf = Buffer.concat([buf, data]);
        if (!h) { if (buf.length < HEADER) return cb(); h = parseHeader(buf.subarray(0, HEADER)); buf = buf.subarray(HEADER); }
        while (buf.length > REC) { this.push(openChunk(h.key, h.prefix, n++, buf.subarray(0, REC), false)); buf = buf.subarray(REC); }
        cb();
      } catch (e) { cb(new Error('decryption failed: ' + e.message)); }
    },
    flush(cb) {
      try {
        if (!h) throw new Error('file too short');
        if (buf.length < TAG) throw new Error('file cut off');
        this.push(openChunk(h.key, h.prefix, n, buf, true));
        cb();
      } catch (e) { cb(new Error('decryption failed: ' + e.message)); }
    }
  });
}

function isEncrypted(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(4); return fs.readSync(fd, b, 0, 4, 0) === 4 && b.equals(MAGIC); }
  catch (e) { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// The first plain bytes of an encrypted file (to recognise its type), decrypting only the first chunk.
function readHead(file, want = 16) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, b = Buffer.alloc(Math.min(size, HEADER + CHUNK + TAG));
    fs.readSync(fd, b, 0, b.length, 0);
    const h = parseHeader(b.subarray(0, HEADER)), rec = b.subarray(HEADER);
    return openChunk(h.key, h.prefix, 0, rec, size <= HEADER + CHUNK + TAG).subarray(0, want);
  } finally { fs.closeSync(fd); }
}
// Whole file decrypted, as a SHA-256 hash and byte count (for checks), streaming.
function decryptedDigest(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'); let size = 0;
    fs.createReadStream(file).on('error', reject).pipe(decryptStream()).on('error', reject)
      .on('data', d => { hash.update(d); size += d.length; }).on('end', () => resolve({ sha256: hash.digest('hex'), size }));
  });
}
const encryptedSize = plain => HEADER + plain + TAG * Math.max(1, Math.ceil(plain / CHUNK));

module.exports = { init, encryptStream, decryptStream, isEncrypted, readHead, decryptedDigest, encryptedSize, MAGIC };

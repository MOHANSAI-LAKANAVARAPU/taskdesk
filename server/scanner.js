// Virus scanning (Security A2): every upload is streamed to ClamAV (the "clamav" container, clamd INSTREAM over TCP)
// while it is being received and encrypted. scan() returns a pass-through stream for the upload pipeline and a promise
// of the verdict: { clean: true } or { clean: false, signature }. If clamd can't be reached or doesn't answer, the
// promise is rejected (code SCANNER_DOWN), and the upload is refused rather than accepted unscanned.
const net = require('net');
const { Transform } = require('stream');

const HOST = process.env.CLAMAV_HOST || 'clamav';
const PORT = Number(process.env.CLAMAV_PORT) || 3310;
const CONNECT_MS = 5000, REPLY_MS = 5 * 60e3;
const down = msg => Object.assign(new Error(msg), { code: 'SCANNER_DOWN' });

function scan() {
  const sock = net.connect({ host: HOST, port: PORT });
  let reply = '', settled = false, resolveV, rejectV;
  const verdict = new Promise((res, rej) => { resolveV = res; rejectV = rej; });
  verdict.catch(() => {}); // handled by whoever awaits it
  const finish = (err, v) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); err ? rejectV(err) : resolveV(v); };
  let timer = setTimeout(() => finish(down(`no connection to the virus scanner at ${HOST}:${PORT}`)), CONNECT_MS);
  sock.once('connect', () => { clearTimeout(timer); timer = setTimeout(() => finish(down('the virus scanner did not answer in time')), REPLY_MS); });
  sock.on('error', e => finish(down(`virus scanner ${HOST}:${PORT}: ${e.code || e.message}`)));
  sock.on('data', d => { reply += d.toString('latin1'); if (reply.includes('\0')) parse(); });
  sock.on('end', () => (reply ? parse() : finish(down('the virus scanner closed the connection'))));
  function parse() {
    const r = reply.replace(/\0[\s\S]*$/, '').trim(); // "stream: OK" | "stream: <name> FOUND" | "... ERROR"
    if (/^stream: OK$/.test(r)) return finish(null, { clean: true });
    const m = r.match(/^stream: (.+) FOUND$/);
    if (m) return finish(null, { clean: false, signature: m[1] });
    if (/size limit exceeded/i.test(r)) return finish(Object.assign(new Error('the file is larger than the virus scanner accepts'), { code: 'SCAN_TOO_BIG' }));
    finish(down(`virus scanner error: ${r.slice(0, 200)}`));
  }
  sock.write('zINSTREAM\0');
  const frame = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  // Passes the upload through unchanged while sending it to clamd in chunks; waits for the socket (backpressure).
  const stream = new Transform({
    transform(data, enc, cb) {
      if (settled) return cb(); // scanner already failed: the verdict says so; let the upload finish to be discarded
      sock.write(frame(data.length)); sock.write(data, () => cb(null, data));
    },
    flush(cb) { if (!settled) sock.write(frame(0)); cb(); }
  });
  return { stream, verdict };
}

// Is clamd up? (startup log and checks). Resolves true/false.
function ping() {
  return new Promise(res => {
    const s = net.connect({ host: HOST, port: PORT }); let got = '';
    const t = setTimeout(() => { s.destroy(); res(false); }, CONNECT_MS);
    s.on('connect', () => s.write('zPING\0')); s.on('data', d => { got += d; if (got.includes('PONG')) { clearTimeout(t); s.destroy(); res(true); } });
    s.on('error', () => { clearTimeout(t); res(false); });
  });
}

module.exports = { scan, ping, HOST, PORT };

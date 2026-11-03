// "Moved" notice server (AWS prep). After the move to AWS the laptop server is stopped, but desktop apps that still point at it
// can only learn the new address (and fetch the 1.0.18 update that knows how to follow it) from the laptop. This tiny server
// answers just that, with no database and no keys (it never opens data/, so the laptop data stays exactly as it was):
//   GET /api/version        -> { "build": "moved", "moved_to": "<MOVED_TO>" }
//   GET /updates/<file>     -> the desktop installers and latest*.yml from UPDATES_DIR (like the real server's /updates)
//   GET /api/health         -> { "ok": true }
//   anything else           -> 503, a short page (or JSON for /api/*) saying TaskDesk has moved
// Settings (environment): MOVED_TO=https://taskdesk.example.com (required), UPDATES_DIR=./updates, PORT=3000, HOST=0.0.0.0.
//   cd server && MOVED_TO=https://taskdesk.example.com node scripts/moved-notice.js
//   docker run -d --restart unless-stopped -p 3000:3000 -e MOVED_TO=… -v "$PWD/updates:/app/updates:ro" -u 1000:1000 \
//     --read-only taskdesk-taskdesk node scripts/moved-notice.js
// (MOVED_TO accepts https only; TASKDESK_TEST_ALLOW_HTTP_MOVE=1 also allows http for tests.)
const http = require('http');
const fs = require('fs');
const path = require('path');

const raw = String(process.env.MOVED_TO || '').trim();
let MOVED_TO = '';
try {
  const u = new URL(raw);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && process.env.TASKDESK_TEST_ALLOW_HTTP_MOVE === '1')) || !u.hostname || u.username || u.password || u.search || u.hash) throw new Error('bad');
  MOVED_TO = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
} catch (e) { console.error('[moved-notice] MOVED_TO must be an https:// address (got "' + raw + '").'); process.exit(1); }
const UPDATES = path.resolve(process.env.UPDATES_DIR || path.join(__dirname, '..', 'updates'));
const PORT = Number(process.env.PORT) || 3000, HOST = process.env.HOST || '0.0.0.0';
const TYPES = { '.yml': 'text/yaml', '.exe': 'application/octet-stream', '.AppImage': 'application/octet-stream', '.blockmap': 'application/octet-stream', '.deb': 'application/octet-stream' };
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const server = http.createServer((req, res) => {
  const headers = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  const json = (code, body) => { res.writeHead(code, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return json(400, { error: 'Bad request.' }); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(503, { error: 'TaskDesk has moved to ' + MOVED_TO });
  if (pathname === '/api/version') return json(200, { build: 'moved', moved_to: MOVED_TO });
  if (pathname === '/api/health') return json(200, { ok: true });
  if (pathname.startsWith('/updates/')) {
    const file = path.resolve(UPDATES, '.' + path.sep + pathname.slice('/updates/'.length));
    if (!file.startsWith(UPDATES + path.sep)) return json(404, { error: 'Not found.' });
    let st; try { st = fs.statSync(file); } catch (e) { st = null; }
    if (!st || !st.isFile()) { res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
    return req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
  }
  if (pathname.startsWith('/api/')) return json(503, { error: 'TaskDesk has moved to ' + MOVED_TO, moved_to: MOVED_TO });
  res.writeHead(503, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Retry-After': '3600' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TaskDesk has moved</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1>TaskDesk has moved</h1>
<p>Please use the new address: <a href="${esc(MOVED_TO)}">${esc(MOVED_TO)}</a></p><p>The desktop app switches by itself within a few minutes.</p></body>`);
});
server.listen(PORT, HOST, () => console.log(`[moved-notice] TaskDesk has moved to ${MOVED_TO}; answering on ${HOST}:${PORT}; updates from ${UPDATES}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

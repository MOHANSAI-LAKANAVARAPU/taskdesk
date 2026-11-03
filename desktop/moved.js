// Following a server that announces a new address (AWS move, 1.0.18). The old server (or the "moved notice" server that
// replaces it) answers /api/version with { moved_to: "https://new.example.com" }. This decides whether the app may follow
// it. No Electron here: plain functions, unit-tested with `node test-moved.js`.
//
//   acceptMove(current, announced, { moves, allowHttp }) -> { url } | { reject: 'why' }
//     - the address must be well formed (serverurl.js rules) and https (http only with allowHttp, a test switch);
//     - it must differ from the address in use, and not be one the app already left (a loop A -> B -> A);
//     - at most MAX_MOVES moves are followed in total.
//   The caller still checks that the new address answers like TaskDesk before switching.
const { normalizeServer } = require('./serverurl');
const MAX_MOVES = 3;

function acceptMove(current, announced, opts = {}) {
  if (announced == null || announced === '') return { reject: 'none' };
  if (typeof announced !== 'string' || announced.length > 300) return { reject: 'not a usable address' };
  const n = normalizeServer(announced);
  if (!n.url) return { reject: 'not a usable address' };
  if (!/^https:\/\//i.test(n.url) && !(opts.allowHttp && /^http:\/\//i.test(n.url))) return { reject: 'not https' };
  // Without an explicit scheme normalizeServer would guess one; a move must say what it means.
  if (!/^https?:\/\//i.test(announced.trim())) return { reject: 'no scheme' };
  const cur = normalizeServer(current || '').url || '';
  if (n.url === cur) return { reject: 'same as the current address' };
  const moves = Array.isArray(opts.moves) ? opts.moves : [];
  if (moves.includes(n.url)) return { reject: 'already left that address (loop)' };
  if (moves.length >= MAX_MOVES) return { reject: 'too many moves' };
  return { url: n.url };
}

module.exports = { acceptMove, MAX_MOVES };

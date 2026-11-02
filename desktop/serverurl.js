// Server address handling for the desktop app (Scale). One place decides what a typed or configured address means, so
// moving to a new server (or to https, e.g. on AWS) is one setting. No Electron here: plain functions, unit-tested with
// `node test-serverurl.js`.
//
//   normalizeServer(text) -> { url } | { error }
//     - an address with http:// or https:// is kept as it is (a path is allowed, e.g. https://example.com/taskdesk);
//     - with no scheme: an IP address, "localhost" or anything with a :port gets http:// (an office server), a name with a dot
//       (tasks.example.com) gets https://, a single word (taskdesk) gets http:// (an office computer name);
//     - trailing slashes are removed; spaces, quotes, user:password@, ?query and #fragment are refused.
//   serverFromArgv(argv) -> text | null     the value of --server=<address> (or "--server <address>") on the command line
const NO_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function normalizeServer(input) {
  let t = String(input == null ? '' : input).trim().replace(/^["']+|["']+$/g, '').trim();
  if (!t) return { error: 'Enter the server address.' };
  if (/\s/.test(t)) return { error: 'The address can’t contain spaces.' };
  if (NO_SCHEME.test(t)) {
    if (!/^https?:\/\//i.test(t)) return { error: 'The address must start with http:// or https://' };
    if (/^https?:\/\/[\/\\]/i.test(t)) return { error: 'That doesn’t look like a web address.' }; // https:///x (the parser would take "x" as the host)
  } else {
    const host = t.split('/')[0];
    const bare = host.replace(/^\[.*\]/, 'ipv6');            // [::1]:3000
    const hasPort = /:\d+$/.test(bare);
    const name = bare.replace(/:\d+$/, '');
    const local = /^(\d{1,3}\.){3}\d{1,3}$/.test(name) || name === 'ipv6' || /^localhost$/i.test(name) || !name.includes('.');
    t = (hasPort || local ? 'http://' : 'https://') + t;
  }
  let u;
  try { u = new URL(t); } catch (e) { return { error: 'That doesn’t look like a web address.' }; }
  if (!u.hostname) return { error: 'That doesn’t look like a web address.' };
  if (u.username || u.password) return { error: 'Leave out the user name and password: the address is only where TaskDesk is.' };
  if (u.search || u.hash) return { error: 'The address can’t have ? or # parts.' };
  const path = u.pathname.replace(/\/+$/, '');
  return { url: `${u.protocol}//${u.host}${path}` };
}

function serverFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a.startsWith('--server=')) return a.slice('--server='.length);
    if (a === '--server' && argv[i + 1] && !String(argv[i + 1]).startsWith('--')) return String(argv[i + 1]);
  }
  return null;
}

module.exports = { normalizeServer, serverFromArgv };

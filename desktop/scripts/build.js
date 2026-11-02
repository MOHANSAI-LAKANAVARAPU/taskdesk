// Build one installer: node scripts/build.js win|linux   (npm run dist:win / npm run dist:linux, also used by npm run release)
//
// TASKDESK_SERVER=<address> builds an installer for that server (http://… or https://…):
//   - it becomes the address the setup window offers (taskdesk.defaultServer) AND the address a laptop with no address yet
//     uses without asking (taskdesk.presetServer, which is what makes a silent install work with no window),
//   - and the update feed baked into the installer (<address>/updates).
// Without TASKDESK_SERVER this is exactly `electron-builder --win nsis` / `--linux AppImage` as before (package.json's
// taskdesk.defaultServer and build.publish are used as they are).
// Moving to a new server or to https is therefore:  TASKDESK_SERVER=https://tasks.example.com npm run release
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeServer } = require('../serverurl');
const pkg = require('../package.json');

const which = process.argv[2];
if (!['win', 'linux'].includes(which)) { console.error('Usage: node scripts/build.js win|linux'); process.exit(2); }
const root = path.join(__dirname, '..');
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE; // breaks Electron when set (e.g. inside VS Code)

const args = which === 'win' ? ['--win', 'nsis'] : ['--linux', 'AppImage'];
const raw = (process.env.TASKDESK_SERVER || '').trim();
if (raw) {
  if (!/^https?:\/\//i.test(raw)) { console.error(`TASKDESK_SERVER must start with http:// or https:// (got "${raw}").`); process.exit(2); }
  const n = normalizeServer(raw);
  if (n.error) { console.error(`TASKDESK_SERVER is not a usable address: ${n.error}`); process.exit(2); }
  args.push(`-c.extraMetadata.homepage=${n.url}`, `-c.extraMetadata.taskdesk.defaultServer=${n.url}`, `-c.extraMetadata.taskdesk.presetServer=${n.url}`,
    '-c.publish.provider=generic', `-c.publish.url=${n.url}/updates`);
  console.log(`[build] building for the server ${n.url} (set in the installer; updates from ${n.url}/updates)`);
} else {
  console.log(`[build] no TASKDESK_SERVER: using ${pkg.taskdesk.defaultServer} from package.json`);
}
const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), ...args], { cwd: root, env, stdio: 'inherit' });
if (r.status !== 0) { console.error(`[build] ${which} failed`); process.exit(r.status || 1); }
console.log(`[build] ${which} done`);

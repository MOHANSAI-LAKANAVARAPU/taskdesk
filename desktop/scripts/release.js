// Build the Windows and Linux versions and publish them to the TaskDesk server's updates folder.
// Usage: npm run release   (from desktop/)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const updates = path.join(root, '..', 'server', 'updates');
const installers = path.join(root, '..', 'installers');
const version = require('../package.json').version;
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE; // breaks Electron when set (e.g. inside VS Code)

for (const script of ['dist:win', 'dist:linux']) execSync(`npm run ${script}`, { cwd: root, env, stdio: 'inherit' });

const exe = fs.readdirSync(dist).find(f => f.endsWith(`${version}.exe`));
const appImage = fs.readdirSync(dist).find(f => f.endsWith(`${version}.AppImage`));
if (!exe || !appImage) throw new Error(`Build output for ${version} not found in dist/`);

const updateFiles = [exe, exe + '.blockmap', 'latest.yml', appImage, 'latest-linux.yml'];
fs.mkdirSync(updates, { recursive: true });
fs.mkdirSync(installers, { recursive: true });

// Remove older installers (keep README.txt and anything else that isn't a TaskDesk build).
const isBuild = f => /\.(exe|blockmap|AppImage|deb)$/.test(f);
for (const dir of [updates, installers]) {
  for (const f of fs.readdirSync(dir)) {
    if (isBuild(f) && !updateFiles.includes(f)) { fs.unlinkSync(path.join(dir, f)); console.log('removed old', path.join(dir, f)); }
  }
}
for (const f of updateFiles) { fs.copyFileSync(path.join(dist, f), path.join(updates, f)); console.log('updates/', f); }
for (const f of [exe, appImage]) { fs.copyFileSync(path.join(dist, f), path.join(installers, f)); console.log('installers/', f); }
console.log(`\nReleased ${version}. Laptops will update within 4 hours.`);

# TaskDesk desktop app

Installs on Windows and Ubuntu laptops. After installing:

- A round **TaskDesk icon** appears on the screen every time the laptop starts, showing the number of open tasks.
- Clicking the icon opens the TaskDesk dashboard in its own window.
- A notification pops up when a new task is assigned.
- The icon can be dragged anywhere; right-click it for options. The icon can't be hidden or closed by users. The TaskDesk icon near the clock (system tray) has more options.

The app connects to the TaskDesk server (default address `http://192.168.1.222:3000`).

## Change the default server address before building

Edit `package.json` → `"taskdesk": { "defaultServer": "http://YOUR-SERVER:3000" }`, then rebuild.
Employees can also change it later from the tray menu → **Change server address…**

## Release an update (automatic updates)

Laptops check the TaskDesk server (`<server address>/updates`) 1 minute after start and every 4 hours, then download and install new versions silently and restart the app.

1. Change the code.
2. Bump `version` in `package.json`.
3. Run `npm run release` from this folder. It builds the Windows and Ubuntu versions, copies the update files to `../server/updates/` (served by the server, no Docker rebuild needed) and the installers to `../installers/`, and removes older versions.

Laptops update within 4 hours.

## First-time install

- **Windows:** run `TaskDesk Setup <version>.exe` from `../installers/`.
- **Ubuntu:** run `sudo apt install libfuse2` once (AppImage needs it on Ubuntu 22.04 and newer). Copy the AppImage to `~/Applications`, make it executable (`chmod +x ~/Applications/TaskDesk-*.AppImage`) and run it once. It then starts at login and updates itself without a password.

## Build only (no publishing)

```bash
npm install
npm run dist:linux   # dist/TaskDesk-<version>.AppImage
npm run dist:win     # dist/TaskDesk Setup <version>.exe (on Linux this needs wine64 and wine32)
```

If `npm start` or a build crashes with "Cannot read properties of undefined (reading 'setPath')", run `unset ELECTRON_RUN_AS_NODE` first.

Run during development: `npm start` (auto-update is off unless the app is packaged)

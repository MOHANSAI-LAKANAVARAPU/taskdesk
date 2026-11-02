# TaskDesk desktop app

Installs on Windows and Ubuntu laptops. After installing:

- A round **TaskDesk icon** appears on the screen every time the laptop starts, showing the number of open tasks.
- Clicking the icon opens the TaskDesk dashboard in its own window.
- A notification pops up when a new task is assigned.
- The icon can be dragged anywhere; right-click it for options. The icon can't be hidden or closed by users. The TaskDesk icon near the clock (system tray) has more options.

The app connects to the TaskDesk server (default address `http://192.168.1.222:3000`).

## The server address (moving to a new server, or to https)

The address is one setting. Where it comes from, in this order:

1. **`--server=<address>` on the command line** (IT): saved and used at once. Also when the app is already running: the second start switches the running app and reloads it.
2. **An address already saved on the laptop** (`config.json`, or whatever the person chose in setup): kept.
3. **The address the installer was built for** (`TASKDESK_SERVER`, below): used without asking the first time, if the laptop has none yet.
4. Otherwise the setup window opens, offering `taskdesk.defaultServer` from `package.json` (`http://192.168.1.222:3000` today; **not changed**).

What a person (or IT) may type: `http://192.168.1.222:3000`, `192.168.1.222:3000` (an IP address or `host:port` means `http://`), `https://tasks.yourcompany.com` or just `tasks.yourcompany.com` (a name with a dot means `https://`), a single word like `taskdesk` (an office computer name, `http://`). `serverurl.js` decides this; `node test-serverurl.js` tests it. Users can change it any time from the tray menu → **Change server address…**

**Build installers for another server** (one setting, nothing to edit):

```bash
TASKDESK_SERVER=https://tasks.yourcompany.com npm run release     # or npm run dist:win / dist:linux
```

The address (it must start with `http://` or `https://`) becomes the address the setup window offers, the address a new laptop uses without asking (so a silent install shows no window), and the update feed (`<address>/updates`). Without `TASKDESK_SERVER` the installers are built exactly as before. `npm run release` copies the files to `../server/updates/` of *this* computer; for another server, copy `../server/updates/*` (the `.exe`, `.blockmap`, `.AppImage`, `latest.yml`, `latest-linux.yml`) into that server's `updates/` folder.

**https needs:** `COOKIE_SECURE=true` in the server's `.env` (the sign-in cookie is then marked Secure) and a certificate the laptops trust (a public one, or your company's CA installed on the laptops). With a certificate they don't trust, setup says so and the app can't update.

**Laptops that already have an address keep it**, also after an update (an address saved on the laptop always wins over the one built into an installer). To move installed laptops to a new server, run `TaskDesk.exe --server=https://tasks.yourcompany.com` on each (one line for IT, see below; it works while the app is running too), or ask people to use **Change server address…** in the tray menu. The updates they receive come from the address they have saved, so publish the new version on the old server too, or move them first.

## Silent install (for IT)

**Windows** (`TaskDesk Setup <version>.exe`, a one-click per-user installer; no administrator rights needed). *These options come from the installer's own script and its flag list (electron-builder's NSIS template); the Windows installer has not been run on a real Windows PC while writing this, so try it once on a spare PC before rolling it out.*

```bat
:: install without any window, then start it once (the app sets up "start at login" the first time it runs)
"TaskDesk Setup 1.0.17.exe" /S --force-run
:: the same, no desktop shortcut, a different folder (/D must be the last option, no quotes)
"TaskDesk Setup 1.0.17.exe" /S --force-run --no-desktop-shortcut /D=C:\Apps\TaskDesk
```

- **`/S` installs silently and does not start the app.** The installer only starts it in silent mode when you add `--force-run`. The app turns on "start at login" itself the first time it runs (per user, in `HKCU\...\Run`), so a silent install that never starts it has no start at login: use `--force-run`, or start it once.
- **It installs for the user who runs it** into `%LOCALAPPDATA%\Programs\TaskDesk` (a Windows service or a deployment tool running as SYSTEM would install into SYSTEM's profile, which nobody uses). Use a "run as the signed-in user" rule in Intune, SCCM or Group Policy, or a logon script. There is no all-users option in this installer.
- **Presetting the server address**, best first:
  1. Build the installer with `TASKDESK_SERVER=https://tasks.yourcompany.com` (above): the installed app uses it at first start, no window.
  2. Pass it when starting: `"%LOCALAPPDATA%\Programs\TaskDesk\TaskDesk.exe" --server=https://tasks.yourcompany.com` (saved; also re-points an app that is already running).
  3. Put a file before the first start: `%APPDATA%\TaskDesk\config.json` containing `{ "server": "https://tasks.yourcompany.com" }`.
  With none of these, the person sees the setup window once and types the address.
- **Updates** need no IT work: the app checks `<server>/updates` 1 minute after start and every 4 hours and installs new versions silently (the installer is then run with `--updated`).
- **Uninstall silently:** `"%LOCALAPPDATA%\Programs\TaskDesk\Uninstall TaskDesk.exe" /S` (add `--delete-app-data` to also remove the saved settings).
- Other installer options: `--keep-shortcuts`, `--no-desktop-shortcut`, `--currentuser` / `--allusers` (this one-click build only does per-user).

**Ubuntu** (`TaskDesk-<version>.AppImage`; no installer): once per computer `sudo apt install libfuse2`; then, as the user:

```bash
mkdir -p ~/Applications && cp TaskDesk-1.0.17.AppImage ~/Applications/ && chmod +x ~/Applications/TaskDesk-1.0.17.AppImage
~/Applications/TaskDesk-1.0.17.AppImage --server=https://tasks.yourcompany.com &    # first run: saves the address, sets up start at login
```

The app adds its own login entry (`~/.config/autostart/taskdesk.desktop`) the first time it runs and updates itself in place, without a password.

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

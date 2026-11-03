const { app, BrowserWindow, Tray, Menu, Notification, screen, ipcMain, nativeImage, session, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pkg = require('./package.json');
const { autoUpdater } = require('electron-updater');
const { normalizeServer, serverFromArgv } = require('./serverurl');
const { acceptMove } = require('./moved');

// The address the setup window offers (taskdesk.defaultServer in package.json, or TASKDESK_SERVER when the installer was built:
// scripts/build.js). PRESET_SERVER is only set when an installer was built for one server on purpose (TASKDESK_SERVER set):
// a laptop with no address yet then uses it without asking (silent installs, see README "Silent install").
const DEFAULT_SERVER = (pkg.taskdesk && pkg.taskdesk.defaultServer) || '';
const PRESET_SERVER = (pkg.taskdesk && pkg.taskdesk.presetServer) || '';
const POLL_MS = 60 * 1000;
const WIDGET_SIZE = 104;
const ICON = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');
const launchedAtLogin = process.argv.includes('--autostart');

if (process.env.TASKDESK_USER_DATA) app.setPath('userData', process.env.TASKDESK_USER_DATA); // for testing
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');
if (process.platform === 'win32') app.setAppUserModelId('com.hifocus.taskdesk');

// ---------- log file (userData/taskdesk.log) ----------
function setupLog() {
  try {
    const file = path.join(app.getPath('userData'), 'taskdesk.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old'); } catch (e) { /* no log yet */ }
    for (const level of ['log', 'warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...a) => {
        orig(...a);
        try { fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${a.map(x => (x && x.stack) || String(x)).join(' ')}\n`); } catch (e) { /* ignore */ }
      };
    }
  } catch (e) { /* logging is best effort */ }
}
setupLog();
console.log(`TaskDesk ${pkg.version} starting (${process.platform}, packaged=${app.isPackaged}, session=${process.env.XDG_SESSION_TYPE || '-'}, args=${process.argv.slice(1).join(' ')})`);

if (!app.requestSingleInstanceLock()) { console.log('Another TaskDesk is already running; exiting.'); app.quit(); }
else { app.on('second-instance', (e, argv) => {
  // Started again with --server=<address> while running (IT re-pointing a laptop): switch to it and reload.
  const n = serverFromArgv(argv) ? normalizeServer(serverFromArgv(argv)) : null;
  if (n && n.url && n.url !== cfg.server) { applyServer(n.url); if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(cfg.server); schedulePoll(500); }
  createWidget(); openDashboard();
}); }

// ---------- config ----------
let cfgPath;
let cfg = { server: '', showWidget: true, autoStart: true, widgetPos: null, widgetPositions: {}, knownUser: null, knownTaskIds: [], knownStatuses: null, knownApprovalIds: null, knownRequestIds: null, knownReadyIds: null, knownNeedsTeamIds: null, knownReminderIds: null, knownAskIds: null, knownWithdrawnIds: null, knownNoteIds: null, moves: [] };
function loadConfig() {
  cfgPath = path.join(app.getPath('userData'), 'config.json');
  try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8'))); } catch (e) { /* first run */ }
  cfg.showWidget = true; cfg.autoStart = true; // always on, even if an old config.json says false
}
function saveConfig() {
  try { fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.error('Could not save config', e); }
}
const cleanUrl = u => normalizeServer(u).url || '';
// Use this server from now on. Another server means another person's tasks: forget what was "already announced".
function applyServer(url) {
  const changed = url !== cfg.server;
  cfg.server = url;
  if (changed) { cfg.knownUser = null; cfg.knownTaskIds = []; cfg.knownStatuses = null; cfg.knownApprovalIds = null; cfg.knownRequestIds = null; cfg.knownReadyIds = null; cfg.knownNeedsTeamIds = null; cfg.knownReminderIds = null; cfg.knownAskIds = null; cfg.knownWithdrawnIds = null; cfg.knownNoteIds = null; }
  saveConfig();
}

// ---------- windows ----------
let mainWin = null, widgetWin = null, setupWin = null, tray = null, quitting = false;
let lastSummary = { state: 'starting', open: 0, overdue: 0, chat: 0 };
let pollTimer = null;
let lastCheck = null; // { ok, time, open, reason } — shown in the menus and logged, to diagnose a missing badge

function createMain() {
  mainWin = new BrowserWindow({
    width: 1200, height: 820, minWidth: 380, minHeight: 500, show: false, icon: ICON, title: 'TaskDesk',
    autoHideMenuBar: true, backgroundColor: '#F2F4F6',
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') }
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.on('close', e => { if (!quitting) { e.preventDefault(); mainWin.hide(); } });
  const wc = mainWin.webContents;
  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    if (!url.startsWith(cfg.server)) { e.preventDefault(); shell.openExternal(url); }
  });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3) mainWin.loadFile(path.join(__dirname, 'offline.html'), { query: { server: cfg.server, err: desc } });
  });
  // After sign-in, sign-out or any page change inside the app, refresh the icon badge soon.
  wc.on('did-navigate-in-page', () => schedulePoll(1500));
  wc.on('did-finish-load', () => schedulePoll(1500));
  mainWin.loadURL(cfg.server);
}

function openDashboard(hashPath) {
  if (!cfg.server) return openSetup();
  if (!mainWin || mainWin.isDestroyed()) createMain();
  if (hashPath) mainWin.loadURL(cfg.server + '/#' + hashPath);
  else if (mainWin.webContents.getURL().startsWith('file:')) mainWin.loadURL(cfg.server); // retry after offline
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.show(); setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 480, height: 500, resizable: false, icon: ICON, title: 'Connect TaskDesk', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') }
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname, 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; if (!cfg.server) app.quit(); });
}

// ---------- floating icon ----------
// The mascot is on every workspace / virtual desktop and above every window. Only the mascot: the dashboard is a
// normal window.
// - Linux (X11): "all workspaces" is the window manager's _NET_WM_STATE_STICKY / _NET_WM_DESKTOP = 0xFFFFFFFF. Electron
//   only gets that when setVisibleOnAllWorkspaces runs after the window is shown (before, GNOME drops it on map), so
//   keepWidgetUp() runs after every show, move, display change and every 2 s. type 'dock' keeps it out of the taskbar
//   and Alt+Tab, above "always on top" windows, and stops GNOME from handing it the focus when another window closes
//   (it did with 'normal', 'toolbar' and 'notification'). Not `focusable: false`: on X11 Electron makes that an
//   override-redirect window the window manager doesn't manage at all (no sticky, no "above" state).
// - Windows: setVisibleOnAllWorkspaces does nothing there and Windows has no public API to pin a window to every
//   virtual desktop. The mascot is a topmost ('screen-saver', the highest level) skip-taskbar tool window, re-asserted
//   every 2 s.
const WIDGET_TOP_LEVEL = 'screen-saver';
const ON_ALL_WORKSPACES = { visibleOnFullScreen: true };
// Positions are remembered per monitor setup (e.g. laptop alone vs laptop + HDMI), keyed by the monitors' bounds.
const displaySetup = () => screen.getAllDisplays().map(d => `${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}`).sort().join('|');
function defaultWidgetPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIDGET_SIZE - 24, y: wa.y + wa.height - WIDGET_SIZE - 24 };
}
function onSomeScreen(p) {
  return p && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return p.x >= a.x - 20 && p.y >= a.y - 20 && p.x + WIDGET_SIZE <= a.x + a.width + 20 && p.y + WIDGET_SIZE <= a.y + a.height + 20;
  });
}
// Where the mascot belongs now: the place saved for this monitor setup, else where it is (if that monitor is still
// there), else the primary monitor's bottom-right corner.
function widgetPlace(current) {
  const saved = (cfg.widgetPositions || {})[displaySetup()];
  if (onSomeScreen(saved)) return saved;
  if (onSomeScreen(current)) return current;
  if (!current && onSomeScreen(cfg.widgetPos)) return cfg.widgetPos; // saved by an older version
  return defaultWidgetPos();
}
function saveWidgetPos() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  const [x, y] = widgetWin.getPosition();
  cfg.widgetPos = { x, y };
  cfg.widgetPositions = Object.assign({}, cfg.widgetPositions, { [displaySetup()]: { x, y } });
  saveConfig();
}
// Re-assert "on top" and "all workspaces" (cheap; no flicker, never focuses). Not while quitting or updating.
function keepWidgetUp(raise) {
  const w = widgetWin;
  if (!w || w.isDestroyed() || quitting || !w.isVisible()) return;
  w.setAlwaysOnTop(true, WIDGET_TOP_LEVEL);
  if (process.platform !== 'win32') w.setVisibleOnAllWorkspaces(true, ON_ALL_WORKSPACES);
  if (raise && process.platform === 'linux') w.moveTop(); // X11 raise, no focus change (Windows: topmost is enough)
}
// Startup log: what the window manager actually did (Linux: xprop when it's installed).
function logWidgetState(why) {
  const w = widgetWin;
  if (!w || w.isDestroyed()) return;
  const electron = `alwaysOnTop=${w.isAlwaysOnTop()} allWorkspaces=${w.isVisibleOnAllWorkspaces()}`;
  if (process.platform !== 'linux') return console.log(`[widget] ${why}: ${electron}`);
  const xid = '0x' + w.getNativeWindowHandle().readUInt32LE(0).toString(16);
  require('child_process').execFile('xprop', ['-id', xid, '_NET_WM_STATE', '_NET_WM_DESKTOP', '_NET_WM_WINDOW_TYPE'], (err, out) => {
    const x = err ? `xprop not available (${err.code || err.message})` : out.trim().replace(/\s*\n\s*/g, '; ');
    const sticky = !err && /_NET_WM_STATE_STICKY/.test(out) && /_NET_WM_DESKTOP\(CARDINAL\) = 4294967295/.test(out);
    console.log(`[widget] ${why}: ${electron}; window ${xid}: ${x}${err ? '' : sticky ? ' → on all workspaces' : ' → NOT on all workspaces'}`);
  });
}
let widgetTimer = null;
function createWidget() {
  if (widgetWin && !widgetWin.isDestroyed()) { widgetWin.showInactive(); keepWidgetUp(true); return; }
  const pos = widgetPlace(null);
  widgetWin = new BrowserWindow({
    x: pos.x, y: pos.y, width: WIDGET_SIZE, height: WIDGET_SIZE, useContentSize: true, frame: false, transparent: true, resizable: false,
    movable: true, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, show: false, title: 'TaskDesk', ...(process.platform === 'linux' ? { type: 'dock' } : {}),
    webPreferences: { contextIsolation: true, sandbox: true, zoomFactor: 1, preload: path.join(__dirname, 'preload.js') }
  });
  widgetWin.setAlwaysOnTop(true, WIDGET_TOP_LEVEL);
  // Page zoom (Ctrl+wheel) would push the badge out of the window; keep it at 100%.
  widgetWin.webContents.on('did-finish-load', () => { widgetWin.webContents.setZoomFactor(1); widgetWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {}); });
  widgetWin.webContents.on('zoom-changed', () => widgetWin.webContents.setZoomFactor(1));
  widgetWin.loadFile(path.join(__dirname, 'widget.html'));
  // 'ready-to-show' can fail to fire for transparent windows on some Linux setups, so also show on load and after a timeout.
  const w = widgetWin;
  w.on('show', () => { keepWidgetUp(); setTimeout(keepWidgetUp, 500); }); // after the window manager has mapped it
  w.once('show', () => setTimeout(() => logWidgetState('shown'), 1500));
  w.on('moved', () => keepWidgetUp());
  w.on('blur', () => keepWidgetUp(true));
  clearInterval(widgetTimer);
  widgetTimer = setInterval(() => keepWidgetUp(true), 2000);
  const reveal = why => { if (!w.isDestroyed() && !w.isVisible()) { console.log('Floating icon shown (' + why + ')'); w.showInactive(); } sendSummary(); };
  w.once('ready-to-show', () => reveal('ready-to-show'));
  w.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  setTimeout(() => reveal('timeout'), 3000);
  w.webContents.on('did-fail-load', (e, code, desc) => console.error('Floating icon failed to load:', code, desc));
  console.log(`Floating icon created at ${pos.x},${pos.y}`);
  // The icon can't be closed or hidden by the user. Only a real quit (shutdown, logout, installer) lets it go.
  widgetWin.on('close', e => { if (!quitting) e.preventDefault(); });
  widgetWin.on('session-end', () => { quitting = true; }); // Windows shutdown/logoff: never block it
  widgetWin.on('hide', () => { if (!quitting && widgetWin && !widgetWin.isDestroyed()) widgetWin.showInactive(); });
  widgetWin.on('closed', () => { widgetWin = null; clearInterval(widgetTimer); console.log('Floating icon window closed; quitting=' + quitting); if (!quitting) createWidget(); });
  widgetWin.webContents.on('render-process-gone', (e, d) => {
    console.error('Floating icon renderer gone:', d && d.reason);
    if (quitting || !widgetWin || widgetWin.isDestroyed()) return;
    widgetWin.destroy(); // 'closed' recreates it
  });
}

let dragStart = null;
ipcMain.on('widget-drag-start', () => { if (widgetWin) { const [x, y] = widgetWin.getPosition(); dragStart = { x, y }; } });
ipcMain.on('widget-drag-move', (e, { dx, dy }) => {
  // setBounds keeps the size fixed: with Windows display scaling, setPosition can make the window drift in size.
  if (widgetWin && dragStart) widgetWin.setBounds({ x: Math.round(dragStart.x + dx), y: Math.round(dragStart.y + dy), width: WIDGET_SIZE, height: WIDGET_SIZE });
});
ipcMain.on('widget-drag-end', () => {
  if (widgetWin) { saveWidgetPos(); keepWidgetUp(); }
  dragStart = null;
});
// Monitor plugged in, unplugged or changed: back to the place saved for this setup, or the primary monitor if the
// mascot's monitor is gone. The window manager may have moved it already, so wait a moment.
function onDisplaysChanged(why) {
  setTimeout(() => {
    if (!widgetWin || widgetWin.isDestroyed()) return;
    const [x, y] = widgetWin.getPosition(), p = widgetPlace({ x, y });
    if (p.x !== x || p.y !== y) widgetWin.setBounds({ x: p.x, y: p.y, width: WIDGET_SIZE, height: WIDGET_SIZE });
    console.log(`[widget] displays ${why} (${displaySetup()}): mascot at ${p.x},${p.y}`);
    keepWidgetUp(true);
    logWidgetState('after display change');
  }, 800);
}
ipcMain.on('widget-click', () => openDashboard());
ipcMain.on('widget-ready', () => sendSummary());
// Log where the badge actually is (only when it changes), e.g. to diagnose a badge that's missing on one laptop.
let lastBadgeLog = '';
ipcMain.on('widget-rendered', (e, i) => {
  const outside = (i.text && (i.x < 0 || i.y < 0 || i.x + i.w > i.iw || i.y + i.h > i.ih)) || (i.chat && (i.cx < 0 || i.cy < 0 || i.cx + i.cw > i.iw || i.cy + i.ch > i.ih));
  const line = `[widget] badge ${i.text ? `"${i.text}" at ${i.x},${i.y} ${i.w}x${i.h}` : 'hidden'}, chat ${i.chat ? `"${i.chat}" at ${i.cx},${i.cy} ${i.cw}x${i.ch}` : 'hidden'} in ${i.iw}x${i.ih} page`
    + ` (device scale ${i.dpr}, window ${widgetWin && !widgetWin.isDestroyed() ? widgetWin.getContentSize().join('x') : '?'})${outside ? ' OUTSIDE THE WINDOW' : ''}`;
  if (line !== lastBadgeLog) { lastBadgeLog = line; (outside ? console.warn : console.log)(line); }
});
ipcMain.on('widget-menu', () => {
  Menu.buildFromTemplate([
    ...infoItems(),
    { label: 'Open TaskDesk', click: () => openDashboard() },
    chatMenuItem(),
    { label: 'Refresh', click: () => refreshAll() }
  ]).popup({ window: widgetWin });
});

// ---------- setup / offline IPC ----------
ipcMain.handle('get-config', () => ({ server: cfg.server || DEFAULT_SERVER }));
ipcMain.handle('test-server', async (e, text) => {
  // The person types whatever they were given (an IP, a name, http:// or https://); serverurl.js decides what it means and the
  // answer carries the exact address to save.
  const n = normalizeServer(text);
  if (n.error) return { ok: false, error: n.error };
  const url = n.url;
  try {
    const r = await fetch(url + '/api/me', { signal: AbortSignal.timeout(6000) });
    const type = r.headers.get('content-type') || '';
    if ((r.status === 200 || r.status === 401) && type.includes('json')) return { ok: true, url };
    return { ok: false, error: 'Something answered at this address, but it isn’t TaskDesk.' };
  } catch (err) {
    const cert = /cert|ssl|tls/i.test(`${err && err.cause && err.cause.code || ''} ${err && err.cause && err.cause.message || ''} ${err && err.message || ''}`);
    return { ok: false, error: cert ? 'The address answered, but its security certificate isn’t trusted on this computer. Ask IT.'
      : 'Can’t reach this address. Check that you’re on the office network and the address is correct.' };
  }
});
ipcMain.handle('save-server', (e, text) => {
  const n = normalizeServer(text);
  if (n.error) return false;
  applyServer(n.url);
  if (setupWin) setupWin.destroy();
  startApp(true);
  return true;
});
ipcMain.on('retry', () => { if (mainWin) mainWin.loadURL(cfg.server); });
ipcMain.on('open-setup', () => openSetup());

// ---------- task summary polling ----------
function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }

function recordCheck(ok, info) {
  lastCheck = Object.assign({ ok, time: new Date() }, info);
  if (ok) console.log(`[summary] ok user=${info.user} open=${info.own} approvals=${info.approvals} assign=${info.assign} badge=${info.open} overdue=${info.overdue}`
    + ` team_requests=${info.teamRequests} ready=${info.ready} needs_team=${info.needsTeam} chat=${info.chat}`);
  else console.warn(`[summary] failed: ${info.reason}`);
  buildTrayMenu();
}
function checkLine() {
  if (!lastCheck) return 'Last check: not yet';
  const t = lastCheck.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return lastCheck.ok ? `Last check: ${t} (${lastCheck.open} open)` : `Last check failed: ${lastCheck.reason}`;
}
const chatMenuItem = () => ({ label: `Unread messages: ${lastSummary.state === 'ok' ? lastSummary.chat || 0 : '–'}`, click: () => openDashboard('/chat') });
// Disabled info lines at the top of both menus.
function infoItems() {
  return [{ label: `TaskDesk ${app.getVersion()}`, enabled: false }, { label: checkLine(), enabled: false }, { type: 'separator' }];
}

// Reload the dashboard window, keeping the current page (#route); if it's showing the offline page, load the server again.
function reloadDashboard(why) {
  if (!mainWin || mainWin.isDestroyed() || !cfg.server) return;
  const url = mainWin.webContents.getURL();
  console.log(`[dashboard] reload (${why}) ${url.replace(/^.*?#/, '#') || ''}`);
  if (!url || url.startsWith('file:')) mainWin.loadURL(cfg.server);
  else mainWin.webContents.reloadIgnoringCache();
}
function refreshAll() { reloadDashboard('Refresh'); poll(); }
// The server's build id changes whenever new server code or pages are deployed; reload the dashboard when it does.
// The same answer can carry moved_to (AWS move, 1.0.18): the https address TaskDesk now lives at. It is read on every check,
// signed in or not (the old server may be only a "moved notice" that answers nothing else). Returns true when the app moved.
let serverBuild = null, lastMoveNote = '';
const ALLOW_HTTP_MOVE = !app.isPackaged && process.env.TASKDESK_TEST_ALLOW_HTTP_MOVE === '1'; // tests only: never in an installed app
async function checkServerVersion() {
  try {
    const r = await fetch(cfg.server + '/api/version', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const { build, moved_to } = await r.json();
    if (moved_to && await followMove(moved_to)) return true;
    if (!build) return false;
    if (serverBuild && build !== serverBuild) { console.log(`[version] server updated ${serverBuild} -> ${build}`); serverBuild = build; reloadDashboard('server updated'); }
    else if (!serverBuild) { serverBuild = build; console.log(`[version] server build ${build}`); }
  } catch (e) { /* the summary check already logs network problems */ }
  return false;
}
// The server announced a new address. Follow it only if moved.js allows it (https, new, no loop) and the new address answers
// like TaskDesk; otherwise stay where we are and look again at the next check. No dialog: people just sign in again there
// (cookies belong to one address; their accounts come with the data).
async function followMove(announced) {
  const a = acceptMove(cfg.server, announced, { moves: cfg.moves, allowHttp: ALLOW_HTTP_MOVE });
  const note = (m) => { if (m !== lastMoveNote) { lastMoveNote = m; console.log('[move] ' + m); } };
  if (!a.url) return note(`announcement ignored (${a.reject})`), false; // never log the announced text: it may carry credentials
  try {
    const r = await fetch(a.url + '/api/version', { signal: AbortSignal.timeout(5000) });
    const j = r.ok ? await r.json() : null;
    if (j && j.moved_to && normalizeServer(j.moved_to).url === cfg.server) return note(`${a.url} announces ${cfg.server} back (a loop); staying`), false;
    if (!j || typeof j.build !== 'string' || !j.build) return note(`${a.url} does not answer like TaskDesk yet (HTTP ${r.status}); staying on ${cfg.server}`), false;
  } catch (e) {
    const cause = e.cause && (e.cause.code || e.cause.message);
    return note(`can’t reach the new address ${a.url} yet (${cause || e.message}); staying on ${cfg.server}`), false;
  }
  console.log(`[move] moving from ${cfg.server} to ${a.url}`);
  cfg.moves = [...(cfg.moves || []), cfg.server];
  cfg.previousServer = cfg.server;
  applyServer(a.url);
  serverBuild = null; lastMoveNote = '';
  stopStream('moved');
  if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(cfg.server);
  schedulePoll(500);
  return true;
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    if (!cfg.server) return recordCheck(false, { reason: 'no server address set' });
    if (await checkServerVersion()) return; // moved to a new address: the next check runs there
    const cookies = await session.defaultSession.cookies.get({ url: cfg.server, name: 'sid' });
    if (!cookies.length) { stopStream('signed out'); recordCheck(false, { reason: 'not signed in (no session cookie)' }); return setSummary({ state: 'signed-out' }); }
    const r = await fetch(cfg.server + '/api/my-summary', {
      headers: { Cookie: 'sid=' + cookies[0].value }, signal: AbortSignal.timeout(10000)
    });
    if (r.status === 401) { stopStream('session ended'); recordCheck(false, { reason: 'signed out, session expired (HTTP 401)' }); return setSummary({ state: 'signed-out' }); }
    if (!r.ok) { const e = new Error('server error'); e.status = r.status; throw e; }
    const data = await r.json();
    session.defaultSession.cookies.flushStore().catch(() => {}); // keep the sign-in after a restart
    notifyNewTasks(data);
    const approvals = (data.approvals || []).length;
    // Requests waiting for me to assign them: open requests for teams I lead (+ requests without a team for managers/admins).
    const assign = (data.assign_requests || []).length + (data.needs_team_requests || []).length;
    // Badge = my own open tasks + tasks waiting for my approval + requests waiting for me to assign them
    const badge = data.open + approvals + assign;
    setSummary({ state: 'ok', open: badge, own: data.open, approvals, assign, overdue: data.overdue, name: data.user && data.user.name, chat: data.chat_unread || 0 });
    if (data.moved_to) followMove(data.moved_to).catch(() => {});
    startStream(cookies[0].value, data.user && data.user.id); // instant chat messages (no-op while connected for this user)
    recordCheck(true, { user: data.user && data.user.id, own: data.open, approvals, assign, open: badge, overdue: data.overdue, chat: data.chat_unread || 0,
      teamRequests: (data.team_requests || []).length, ready: (data.ready_requests || []).length, needsTeam: (data.needs_team_requests || []).length });
  } catch (e) {
    // fetch wraps the network error; the useful code (ECONNREFUSED, ENOTFOUND, …) is on e.cause or its inner errors.
    const cause = e.cause && (e.cause.code || (e.cause.errors && e.cause.errors[0] && e.cause.errors[0].code) || e.cause.message);
    const reason = e.status ? `server error (HTTP ${e.status})` : e.name === 'TimeoutError' ? 'no answer from server (timeout)' : `can’t reach server (${cause || e.message})`;
    recordCheck(false, { reason });
    setSummary({ state: 'offline' });
  } finally {
    pollTimer = setTimeout(poll, POLL_MS);
  }
}

function notifyNewTasks(data) {
  const ids = data.tasks.map(t => t.id);
  const statuses = {}; for (const t of data.tasks) statuses[t.id] = t.status;
  const approvalIds = (data.approvals || []).map(t => t.id);
  const requestIds = (data.team_requests || []).map(r => r.id), readyIds = (data.ready_requests || []).map(r => r.id);
  const needsTeamIds = (data.needs_team_requests || []).map(r => r.id);
  const reminderIds = (data.unassigned_reminders || []).map(r => r.id);
  const askIds = (data.team_asks || []).map(r => r.id), withdrawnIds = (data.withdrawn || []).map(r => r.id);
  const noteIds = (data.task_notes || []).map(n => n.id);
  if (!data.user || cfg.knownUser !== data.user.id) {
    // First check for this person: remember current tasks without a burst of notifications.
    cfg.knownUser = data.user ? data.user.id : null; cfg.knownTaskIds = ids;
    cfg.knownStatuses = statuses; cfg.knownApprovalIds = approvalIds;
    cfg.knownRequestIds = requestIds; cfg.knownReadyIds = readyIds; cfg.knownNeedsTeamIds = needsTeamIds;
    cfg.knownReminderIds = reminderIds; cfg.knownAskIds = askIds; cfg.knownWithdrawnIds = withdrawnIds; cfg.knownNoteIds = noteIds; saveConfig(); return;
  }
  const known = new Set(cfg.knownTaskIds);
  const fresh = data.tasks.filter(t => !known.has(t.id));

  // Compare with the previous check (older config.json files have no status memory yet: just record it).
  const prevStatuses = cfg.knownStatuses, prevApprovals = cfg.knownApprovalIds;
  const approvedIds = new Set((data.recently_approved || []).map(t => t.id));
  const approvedTitle = id => ((data.recently_approved || []).find(t => t.id === id) || {}).title || 'Your task';
  const reviews = [];   // my submissions that were approved or sent back
  if (prevStatuses) for (const [id, st] of Object.entries(prevStatuses)) {
    if (st !== 'submitted') continue;
    const now = data.tasks.find(t => String(t.id) === id);
    if (now && now.status === 'in_progress') reviews.push({ id: now.id, title: now.title, text: `'${now.title}' was sent back: ${now.sent_back_reason || 'see the task for details'}` });
    else if (approvedIds.has(Number(id))) reviews.push({ id: Number(id), title: approvedTitle(Number(id)), text: `'${approvedTitle(Number(id))}' was approved` });
  }
  const newApprovals = prevApprovals ? (data.approvals || []).filter(t => !prevApprovals.includes(t.id)) : [];
  // Document requests: new ones for my team, and my own requests that became ready.
  const newRequests = cfg.knownRequestIds ? (data.team_requests || []).filter(r => !cfg.knownRequestIds.includes(r.id)) : [];
  const nowReady = cfg.knownReadyIds ? (data.ready_requests || []).filter(r => !cfg.knownReadyIds.includes(r.id)) : [];
  // Managers/admins: requests posted without a team.
  const newNeedsTeam = cfg.knownNeedsTeamIds ? (data.needs_team_requests || []).filter(r => !cfg.knownNeedsTeamIds.includes(r.id)) : [];
  // "Still unassigned" (the server flags a request once, 24 hours after it opened). Remembered ids only grow, so each
  // request reminds once, even if it is given back later. Older config.json files: record silently first.
  const reminders = cfg.knownReminderIds ? (data.unassigned_reminders || []).filter(r => !cfg.knownReminderIds.includes(r.id)) : [];
  cfg.knownReminderIds = [...new Set((cfg.knownReminderIds || []).concat(reminderIds))].slice(-500);
  // Requests sent straight to a member of a team I lead, and requests withdrawn from me (or my team). Remembered ids
  // only grow, so each one notifies once. Older config.json files: record silently first.
  const newAsks = cfg.knownAskIds ? (data.team_asks || []).filter(r => !cfg.knownAskIds.includes(r.id)) : [];
  cfg.knownAskIds = [...new Set((cfg.knownAskIds || []).concat(askIds))].slice(-500);
  const newWithdrawn = cfg.knownWithdrawnIds ? (data.withdrawn || []).filter(r => !cfg.knownWithdrawnIds.includes(r.id)) : [];
  cfg.knownWithdrawnIds = [...new Set((cfg.knownWithdrawnIds || []).concat(withdrawnIds))].slice(-500);
  // Notes and files someone added to my tasks (or, from the assignee, to tasks I assigned). Same once-only memory.
  const newNotes = cfg.knownNoteIds ? (data.task_notes || []).filter(n => !cfg.knownNoteIds.includes(n.id)) : [];
  cfg.knownNoteIds = [...new Set((cfg.knownNoteIds || []).concat(noteIds))].slice(-500);

  cfg.knownTaskIds = ids; cfg.knownStatuses = statuses; cfg.knownApprovalIds = approvalIds;
  cfg.knownRequestIds = requestIds; cfg.knownReadyIds = readyIds; cfg.knownNeedsTeamIds = needsTeamIds; saveConfig();

  const shown = [];
  const notify = (title, body, path) => {
    shown.push(1);
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: ICON });
    n.on('click', () => openDashboard(path));
    n.show();
  };
  if (fresh.length > 3) notify(`${fresh.length} new tasks assigned to you`, 'Click to open TaskDesk.', '/tasks?status=open');
  else for (const t of fresh) {
    const due = t.deadline ? ` · Due ${t.deadline}` : '';
    if (t.asked_by) notify(`${t.asked_by} asked you: ${t.title}`, `Click to open the task.${due}`, '/tasks/' + t.id);
    else notify('New task assigned', `${t.title}\nFrom ${t.assigned_by_name}${due}`, '/tasks/' + t.id);
  }
  if (newApprovals.length > 3) notify(`${newApprovals.length} tasks waiting for your approval`, 'Click to review them.', '/tasks?status=submitted');
  else for (const t of newApprovals) notify(`${t.assignee_name} submitted '${t.title}' for approval`, 'Click to review it.', '/tasks/' + t.id);
  for (const r of reviews) notify(r.text, 'Click to open the task.', '/tasks/' + r.id);
  if (newNotes.length > 3) notify(`${newNotes.length} new notes and files on your tasks`, 'Click to open TaskDesk.', '/tasks');
  else for (const n of newNotes) notify(`${n.by_name} ${n.kind === 'files' ? 'sent files to' : 'added a note to'} '${n.title}'`, 'Click to open the task.', '/tasks/' + n.task_id);
  // The team's lead is asked to assign it; members are told about it.
  for (const r of newRequests.slice(0, 5)) {
    if (r.i_lead) notify(`New request for ${r.team_name}: ${r.title} – assign it to someone`, 'Click to choose who does it.', '/requests/' + r.id);
    else notify(`New document request for ${r.team_name}: ${r.title}`, 'Click to open the request.', '/requests/' + r.id);
  }
  for (const r of reminders.slice(0, 5)) notify(`Still unassigned: ${r.title}`, `Open for more than a day in ${r.team_name}. Click to assign it.`, '/requests/' + r.id);
  for (const r of newAsks.slice(0, 5)) notify(`${r.requested_by_name}${r.requester_team_name ? ` (${r.requester_team_name})` : ''} asked ${r.person_name}: ${r.title}`, 'Click to open the request.', '/requests/' + r.id);
  for (const r of newWithdrawn.slice(0, 5)) notify(`${r.requested_by_name} withdrew: ${r.title}`, 'The task was removed. Click to open the request.', '/requests/' + r.id);
  for (const r of nowReady) notify(`${r.title} is ready`, 'Click to open the request.', '/requests/' + r.id);
  for (const r of newNeedsTeam.slice(0, 5)) notify(`New request needs a team: ${r.title}`, 'Click to choose a team.', '/requests/' + r.id);
  if (shown.length && widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('new-task'); // wave and bounce the mascot
}

// ---------- chat: live stream (/api/stream, Server-Sent Events) ----------
// The server pushes chat events; new messages notify at once and the chat badge follows the unread count. If the
// stream drops it reconnects with a back-off (2 s doubling to 60 s); the summary check each minute keeps the count right.
let streamCtl = null, streamSid = null, streamUser = null, streamRetry = null, streamDelay = 2000;
function stopStream(why) {
  clearTimeout(streamRetry); streamRetry = null;
  if (streamCtl) { console.log(`[stream] stopped (${why})`); streamCtl.abort(); }
  streamCtl = null; streamSid = null; streamUser = null;
}
function startStream(sid, userId) {
  if (streamSid === sid && (streamCtl || streamRetry)) return; // already connected (or about to retry) for this sign-in
  stopStream('new sign-in');
  streamSid = sid; streamUser = userId;
  connectStream();
}
async function connectStream() {
  streamRetry = null;
  const ctl = new AbortController(), sid = streamSid; streamCtl = ctl;
  let reason = 'closed by the server';
  try {
    const r = await fetch(cfg.server + '/api/stream', { headers: { Cookie: 'sid=' + sid, Accept: 'text/event-stream' }, signal: ctl.signal });
    if (r.status === 401) { console.warn('[stream] not signed in (HTTP 401)'); streamCtl = null; streamSid = null; return; } // the next summary check sorts it out
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
    console.log('[stream] connected'); streamDelay = 2000;
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { // one event per blank-line-separated block
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        let event = 'message', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) { try { handleStreamEvent(event, JSON.parse(data)); } catch (e) { console.error('[stream] bad event', e && e.message); } }
      }
    }
  } catch (e) {
    if (ctl.signal.aborted) return; // stopped on purpose
    reason = (e.cause && (e.cause.code || e.cause.message)) || e.message;
  }
  if (streamCtl !== ctl) return;
  streamCtl = null;
  console.warn(`[stream] disconnected: ${reason}; retrying in ${Math.round(streamDelay / 1000)} s`);
  streamRetry = setTimeout(connectStream, streamDelay);
  streamDelay = Math.min(streamDelay * 2, 60000);
}
function setChatCount(n) {
  if (lastSummary.state !== 'ok' || typeof n !== 'number' || n === lastSummary.chat) return;
  setSummary(Object.assign({}, lastSummary, { chat: n }));
}
function handleStreamEvent(event, d) {
  if (event === 'message') { setChatCount(d.unread_total); queueChatNotification(d); }
  else if (event === 'read' || event === 'deleted') setChatCount(d.unread_total);
}
// The conversation the user is looking at: dashboard window shown and focused on #/chat/<id>.
function focusedChatId() {
  if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible() || !mainWin.isFocused()) return null;
  const m = /#\/chat\/(\d+)/.exec(mainWin.webContents.getURL());
  return m ? Number(m[1]) : null;
}
// No notification for my own messages, muted chats, or the chat that is open and focused. Messages arriving within
// 3 seconds of each other are collapsed into one notification.
let chatQueue = [], chatQueueTimer = null;
function queueChatNotification(d) {
  if (!d || !d.message || d.message.sender_id === streamUser || d.muted || focusedChatId() === d.conversation_id) return;
  chatQueue.push(d);
  if (!chatQueueTimer) chatQueueTimer = setTimeout(flushChatNotifications, 3000);
}
function chatNotificationText(d) {
  const m = d.message, sender = m.sender_name || 'Someone';
  if (!m.body) return `${sender} sent a file${d.type === 'direct' ? '' : ` in ${d.conversation_name}`}`;
  const preview = m.body.replace(/\s+/g, ' ').trim();
  const short = preview.length > 100 ? preview.slice(0, 99) + '…' : preview;
  return d.type === 'direct' ? `${sender}: ${short}` : `${sender} in ${d.conversation_name}: ${short}`;
}
function flushChatNotifications() {
  chatQueueTimer = null;
  const q = chatQueue.filter(d => focusedChatId() !== d.conversation_id); chatQueue = [];
  if (!q.length) return;
  const convs = [...new Set(q.map(d => d.conversation_id))];
  let title, path;
  if (q.length === 1) { title = chatNotificationText(q[0]); path = '/chat/' + q[0].conversation_id; }
  else if (convs.length === 1) { title = `${q.length} new messages in ${q[0].conversation_name}`; path = '/chat/' + convs[0]; }
  else { title = `${q.length} new messages in ${convs.length} chats`; path = '/chat'; }
  console.log(`[chat] notify "${title}" -> ${path}`);
  if (Notification.isSupported()) {
    const n = new Notification({ title, body: 'Click to open the chat.', icon: ICON });
    n.on('click', () => openDashboard(path));
    n.show();
  }
  if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('new-task'); // wave the mascot
}

function setSummary(s) {
  lastSummary = Object.assign({ open: 0, overdue: 0, chat: 0 }, s);
  sendSummary();
  buildTrayMenu();
  if (tray) {
    const tip = s.state === 'ok' ? `TaskDesk: ${s.own} open task${s.own === 1 ? '' : 's'}${s.approvals ? `, ${s.approvals} waiting for your approval` : ''}${s.assign ? `, ${s.assign} request${s.assign === 1 ? '' : 's'} to assign` : ''}${s.overdue ? `, ${s.overdue} overdue` : ''}${s.chat ? `, ${s.chat} unread message${s.chat === 1 ? '' : 's'}` : ''}`
      : s.state === 'signed-out' ? 'TaskDesk: sign in to see your tasks'
      : s.state === 'offline' ? 'TaskDesk: can’t reach the server' : 'TaskDesk';
    tray.setToolTip(tip);
  }
  try { app.setBadgeCount(s.state === 'ok' ? s.open : 0); } catch (e) { /* not supported everywhere */ }
}
function sendSummary() { if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('summary', lastSummary); }

// ---------- automatic updates (from our own TaskDesk server) ----------
const UPDATE_FIRST_MS = 60 * 1000;
const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000;
let updaterReady = false, updating = false;
function setupUpdater() {
  if (!app.isPackaged || updaterReady) return; // not in development
  updaterReady = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: m => console.log('[update]', m), warn: m => console.warn('[update]', m),
    error: m => console.error('[update]', m), debug: () => {} };
  autoUpdater.on('error', e => { console.error('[update] error:', e && e.message); });
  autoUpdater.on('update-downloaded', () => {
    console.log('[update] downloaded, installing');
    updating = true;
    quitting = true; // let every window close so the installer can run
    // silent install, then start the new version straight away
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });
  setTimeout(checkForUpdates, UPDATE_FIRST_MS);
  setInterval(checkForUpdates, UPDATE_EVERY_MS);
}
function checkForUpdates() {
  if (!app.isPackaged || updating || !cfg.server) return;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: cfg.server + '/updates' }); // follows the laptop's own server address
    autoUpdater.checkForUpdates().catch(e => console.error('[update] check failed:', e && e.message));
  } catch (e) { console.error('[update] check failed:', e && e.message); }
}

// ---------- start at login ----------
function applyAutoStart() {
  if (!app.isPackaged) return; // don't register the development build
  const on = true; // always start at login
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    const file = path.join(dir, 'taskdesk.desktop');
    try {
      if (on) {
        const exec = process.env.APPIMAGE || process.execPath;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, [
          '[Desktop Entry]', 'Type=Application', 'Name=TaskDesk', 'Comment=Your assigned tasks',
          `Exec="${exec}" --autostart`, 'Icon=taskdesk', 'Terminal=false',
          'X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-Delay=5', ''
        ].join('\n'));
      } else if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) { console.error('Autostart setup failed', e); }
  } else {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--autostart'] });
  }
}

// ---------- tray ----------
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    ...infoItems(),
    { label: 'Open TaskDesk', click: () => openDashboard() },
    { label: 'My open tasks', click: () => openDashboard('/tasks?status=open') },
    chatMenuItem(),
    { type: 'separator' },
    { label: 'Change server address…', click: () => openSetup() },
    { label: 'Refresh', click: () => refreshAll() }
  ]));
}
function createTray() {
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.setToolTip('TaskDesk');
    tray.on('click', () => openDashboard());
    buildTrayMenu();
  } catch (e) { console.error('Tray not available', e); }
}

// ---------- startup ----------
function startApp(openWindow) {
  createTray();
  applyAutoStart();
  setupUpdater();
  createWidget();
  if (openWindow) openDashboard();
  else if (!mainWin) createMain(); // load in the background so the session is ready
  schedulePoll(2000);
}

app.whenReady().then(() => {
  loadConfig();
  // An address given on the command line (--server=https://tasks.example.com, for IT: README "Silent install") is saved and used.
  // With no address at all yet, an installer built for one server (TASKDESK_SERVER) uses that one without asking.
  // Anything else (an address a person chose in setup, a config.json IT put there) is left as it is.
  const argText = serverFromArgv(process.argv);
  if (argText) { const n = normalizeServer(argText); if (n.url) applyServer(n.url); else console.error('[config] ignored --server: ' + n.error); }
  else if (!cfg.server && PRESET_SERVER) { const n = normalizeServer(PRESET_SERVER); if (n.url) applyServer(n.url); }
  Menu.setApplicationMenu(null);
  // Real shutdown / restart / logout: let everything close.
  powerMonitor.on('shutdown', () => { quitting = true; });
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => onDisplaysChanged(ev.replace('display-', '')));
  if (!cfg.server) return openSetup();
  // At login: only show the floating icon. Opened by hand: show the dashboard too.
  startApp(!launchedAtLogin);
});

app.on('window-all-closed', () => { /* keep running in the background */ });
app.on('before-quit', () => { quitting = true; session.defaultSession.cookies.flushStore().catch(() => {}); });
app.on('activate', () => openDashboard());
// Installer/uninstaller or system asking the process to end: don't block it.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { quitting = true; app.quit(); });

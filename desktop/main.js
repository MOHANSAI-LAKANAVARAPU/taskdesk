const { app, BrowserWindow, Tray, Menu, Notification, screen, ipcMain, nativeImage, session, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pkg = require('./package.json');
const { autoUpdater } = require('electron-updater');

const DEFAULT_SERVER = (pkg.taskdesk && pkg.taskdesk.defaultServer) || '';
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
else { app.on('second-instance', () => { createWidget(); openDashboard(); }); }

// ---------- config ----------
let cfgPath;
let cfg = { server: '', showWidget: true, autoStart: true, widgetPos: null, knownUser: null, knownTaskIds: [], knownStatuses: null, knownApprovalIds: null, knownRequestIds: null, knownReadyIds: null, knownNeedsTeamIds: null };
function loadConfig() {
  cfgPath = path.join(app.getPath('userData'), 'config.json');
  try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8'))); } catch (e) { /* first run */ }
  cfg.showWidget = true; cfg.autoStart = true; // always on, even if an old config.json says false
}
function saveConfig() {
  try { fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.error('Could not save config', e); }
}
const cleanUrl = u => String(u || '').trim().replace(/\/+$/, '');

// ---------- windows ----------
let mainWin = null, widgetWin = null, setupWin = null, tray = null, quitting = false;
let lastSummary = { state: 'starting', open: 0, overdue: 0 };
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
    width: 480, height: 360, resizable: false, icon: ICON, title: 'Connect TaskDesk', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') }
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname, 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; if (!cfg.server) app.quit(); });
}

// ---------- floating icon ----------
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
function createWidget() {
  if (widgetWin && !widgetWin.isDestroyed()) { widgetWin.showInactive(); return; }
  const pos = onSomeScreen(cfg.widgetPos) ? cfg.widgetPos : defaultWidgetPos();
  widgetWin = new BrowserWindow({
    x: pos.x, y: pos.y, width: WIDGET_SIZE, height: WIDGET_SIZE, frame: false, transparent: true, resizable: false,
    movable: true, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, show: false, title: 'TaskDesk',
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') }
  });
  widgetWin.setAlwaysOnTop(true, 'floating');
  widgetWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  widgetWin.loadFile(path.join(__dirname, 'widget.html'));
  // 'ready-to-show' can fail to fire for transparent windows on some Linux setups, so also show on load and after a timeout.
  const w = widgetWin;
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
  widgetWin.on('closed', () => { widgetWin = null; console.log('Floating icon window closed; quitting=' + quitting); if (!quitting) createWidget(); });
  widgetWin.webContents.on('render-process-gone', (e, d) => {
    console.error('Floating icon renderer gone:', d && d.reason);
    if (quitting || !widgetWin || widgetWin.isDestroyed()) return;
    widgetWin.destroy(); // 'closed' recreates it
  });
}

let dragStart = null;
ipcMain.on('widget-drag-start', () => { if (widgetWin) { const [x, y] = widgetWin.getPosition(); dragStart = { x, y }; } });
ipcMain.on('widget-drag-move', (e, { dx, dy }) => {
  if (widgetWin && dragStart) widgetWin.setPosition(Math.round(dragStart.x + dx), Math.round(dragStart.y + dy));
});
ipcMain.on('widget-drag-end', () => {
  if (widgetWin) { const [x, y] = widgetWin.getPosition(); cfg.widgetPos = { x, y }; saveConfig(); }
  dragStart = null;
});
ipcMain.on('widget-click', () => openDashboard());
ipcMain.on('widget-menu', () => {
  Menu.buildFromTemplate([
    ...infoItems(),
    { label: 'Open TaskDesk', click: () => openDashboard() },
    { label: 'Refresh', click: () => poll() }
  ]).popup({ window: widgetWin });
});

// ---------- setup / offline IPC ----------
ipcMain.handle('get-config', () => ({ server: cfg.server || DEFAULT_SERVER }));
ipcMain.handle('test-server', async (e, url) => {
  url = cleanUrl(url);
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return { ok: false, error: 'Enter an address that starts with http:// or https://' };
  try {
    const r = await fetch(url + '/api/me', { signal: AbortSignal.timeout(6000) });
    const type = r.headers.get('content-type') || '';
    if ((r.status === 200 || r.status === 401) && type.includes('json')) return { ok: true };
    return { ok: false, error: 'Something answered at this address, but it isn’t TaskDesk.' };
  } catch (err) {
    return { ok: false, error: 'Can’t reach this address. Check that you’re on the office network and the address is correct.' };
  }
});
ipcMain.handle('save-server', (e, url) => {
  const changed = cleanUrl(url) !== cfg.server;
  cfg.server = cleanUrl(url);
  if (changed) { cfg.knownUser = null; cfg.knownTaskIds = []; cfg.knownStatuses = null; cfg.knownApprovalIds = null; cfg.knownRequestIds = null; cfg.knownReadyIds = null; cfg.knownNeedsTeamIds = null; }
  saveConfig();
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
  if (ok) console.log(`[summary] ok user=${info.user} open=${info.own} approvals=${info.approvals} badge=${info.open} overdue=${info.overdue}`
    + ` team_requests=${info.teamRequests} ready=${info.ready} needs_team=${info.needsTeam}`);
  else console.warn(`[summary] failed: ${info.reason}`);
  buildTrayMenu();
}
function checkLine() {
  if (!lastCheck) return 'Last check: not yet';
  const t = lastCheck.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return lastCheck.ok ? `Last check: ${t} (${lastCheck.open} open)` : `Last check failed: ${lastCheck.reason}`;
}
// Disabled info lines at the top of both menus.
function infoItems() {
  return [{ label: `TaskDesk ${app.getVersion()}`, enabled: false }, { label: checkLine(), enabled: false }, { type: 'separator' }];
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    if (!cfg.server) return recordCheck(false, { reason: 'no server address set' });
    const cookies = await session.defaultSession.cookies.get({ url: cfg.server, name: 'sid' });
    if (!cookies.length) { recordCheck(false, { reason: 'not signed in (no session cookie)' }); return setSummary({ state: 'signed-out' }); }
    const r = await fetch(cfg.server + '/api/my-summary', {
      headers: { Cookie: 'sid=' + cookies[0].value }, signal: AbortSignal.timeout(10000)
    });
    if (r.status === 401) { recordCheck(false, { reason: 'signed out, session expired (HTTP 401)' }); return setSummary({ state: 'signed-out' }); }
    if (!r.ok) { const e = new Error('server error'); e.status = r.status; throw e; }
    const data = await r.json();
    session.defaultSession.cookies.flushStore().catch(() => {}); // keep the sign-in after a restart
    notifyNewTasks(data);
    const approvals = (data.approvals || []).length;
    // Badge = my own open tasks + tasks waiting for my approval
    setSummary({ state: 'ok', open: data.open + approvals, own: data.open, approvals, overdue: data.overdue, name: data.user && data.user.name });
    recordCheck(true, { user: data.user && data.user.id, own: data.open, approvals, open: data.open + approvals, overdue: data.overdue,
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
  if (!data.user || cfg.knownUser !== data.user.id) {
    // First check for this person: remember current tasks without a burst of notifications.
    cfg.knownUser = data.user ? data.user.id : null; cfg.knownTaskIds = ids;
    cfg.knownStatuses = statuses; cfg.knownApprovalIds = approvalIds;
    cfg.knownRequestIds = requestIds; cfg.knownReadyIds = readyIds; cfg.knownNeedsTeamIds = needsTeamIds; saveConfig(); return;
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
    notify('New task assigned', `${t.title}\nFrom ${t.assigned_by_name}${due}`, '/tasks/' + t.id);
  }
  if (newApprovals.length > 3) notify(`${newApprovals.length} tasks waiting for your approval`, 'Click to review them.', '/tasks?status=submitted');
  else for (const t of newApprovals) notify(`${t.assignee_name} submitted '${t.title}' for approval`, 'Click to review it.', '/tasks/' + t.id);
  for (const r of reviews) notify(r.text, 'Click to open the task.', '/tasks/' + r.id);
  for (const r of newRequests.slice(0, 5)) notify(`New document request for ${r.team_name}: ${r.title}`, 'Click to open the request.', '/requests/' + r.id);
  for (const r of nowReady) notify(`${r.title} is ready`, 'Click to open the request.', '/requests/' + r.id);
  for (const r of newNeedsTeam.slice(0, 5)) notify(`New request needs a team: ${r.title}`, 'Click to choose a team.', '/requests/' + r.id);
  if (shown.length && widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('new-task'); // wave and bounce the mascot
}

function setSummary(s) {
  lastSummary = Object.assign({ open: 0, overdue: 0 }, s);
  sendSummary();
  if (tray) {
    const tip = s.state === 'ok' ? `TaskDesk: ${s.own} open task${s.own === 1 ? '' : 's'}${s.approvals ? `, ${s.approvals} waiting for your approval` : ''}${s.overdue ? `, ${s.overdue} overdue` : ''}`
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
    { type: 'separator' },
    { label: 'Change server address…', click: () => openSetup() },
    { label: 'Refresh', click: () => poll() }
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
  Menu.setApplicationMenu(null);
  // Real shutdown / restart / logout: let everything close.
  powerMonitor.on('shutdown', () => { quitting = true; });
  if (!cfg.server) return openSetup();
  // At login: only show the floating icon. Opened by hand: show the dashboard too.
  startApp(!launchedAtLogin);
});

app.on('window-all-closed', () => { /* keep running in the background */ });
app.on('before-quit', () => { quitting = true; session.defaultSession.cookies.flushStore().catch(() => {}); });
app.on('activate', () => openDashboard());
// Installer/uninstaller or system asking the process to end: don't block it.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { quitting = true; app.quit(); });

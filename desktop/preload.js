const { contextBridge, ipcRenderer } = require('electron');

// Only the app's own local pages (floating icon, setup, offline) get this bridge.
// The TaskDesk website loaded from the server never sees it.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('td', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    testServer: url => ipcRenderer.invoke('test-server', url),
    saveServer: url => ipcRenderer.invoke('save-server', url),
    retry: () => ipcRenderer.send('retry'),
    openSetup: () => ipcRenderer.send('open-setup'),
    click: () => ipcRenderer.send('widget-click'),
    menu: () => ipcRenderer.send('widget-menu'),
    dragStart: () => ipcRenderer.send('widget-drag-start'),
    dragMove: (dx, dy) => ipcRenderer.send('widget-drag-move', { dx, dy }),
    dragEnd: () => ipcRenderer.send('widget-drag-end'),
    onNewTask: fn => ipcRenderer.on('new-task', () => fn()),
    onSummary: fn => ipcRenderer.on('summary', (e, s) => fn(s))
  });
}

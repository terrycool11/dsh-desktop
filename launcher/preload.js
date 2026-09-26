/* ============================================================
   启动页 preload：只暴露必要的几个通道
   ============================================================ */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshLauncher', {
  info: () => ipcRenderer.invoke('launcher:info'),
  balance: () => ipcRenderer.invoke('launcher:balance'),
  choose: (mode, remember) => ipcRenderer.invoke('launcher:choose', { mode, remember }),
  quit: () => ipcRenderer.invoke('launcher:quit'),
  appIcon: () => ipcRenderer.invoke('platform:app-icon')
});

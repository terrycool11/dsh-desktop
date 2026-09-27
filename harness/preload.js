/* ============================================================
   Harness 窗口（DSH Web UI）的 preload
   只暴露切换视图 + Q 版助手数据两个通道，供注入的元素调用。
   DSH 页面本身的脚本完全不受影响（contextBridge 独立世界）。
   ============================================================ */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshSwitch', {
  to: (target) => ipcRenderer.invoke('view:switch', target),
  current: () => ipcRenderer.invoke('view:current'),
  stats: () => ipcRenderer.invoke('stats:get'),
  refreshStats: () => ipcRenderer.invoke('stats:refresh'),
  mascot: () => ipcRenderer.invoke('mascot:data-url'),
  // 桌宠的真人语音素材（主进程把 assets\voice 里的音频读成 data URL）
  voice: () => ipcRenderer.invoke('pet:voice')
});

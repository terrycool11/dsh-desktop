/* ============================================================
   预加载脚本：把主进程能力以最小面积暴露给面板页面
   （渲染进程保持 sandbox + contextIsolation，页面无法直接碰 Node）
   ============================================================ */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshPlatform', {
  // 基础状态（密钥来源、是否可加密、最近错误）
  state: () => ipcRenderer.invoke('platform:state'),

  // 密钥管理
  saveKey: (key) => ipcRenderer.invoke('platform:save-key', key),
  clearKey: () => ipcRenderer.invoke('platform:clear-key'),
  importKey: () => ipcRenderer.invoke('platform:import-key'),
  testKey: (key) => ipcRenderer.invoke('platform:test-key', key),

  // 开放平台接口
  balance: () => ipcRenderer.invoke('platform:balance'),
  models: () => ipcRenderer.invoke('platform:models'),

  // 对话（流式）
  chatStart: (payload) => ipcRenderer.invoke('platform:chat-start', payload),
  chatAbort: (id) => ipcRenderer.invoke('platform:chat-abort', id),
  onChatChunk: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('platform:chat-chunk', handler);
    return () => ipcRenderer.removeListener('platform:chat-chunk', handler);
  },

  // 杂项
  openExternal: (url) => ipcRenderer.invoke('platform:open-external', url),
  appIcon: () => ipcRenderer.invoke('platform:app-icon'),
  switchView: (target) => ipcRenderer.invoke('view:switch', target),
  onSwitchTab: (cb) => {
    const handler = (_event, tab) => cb(tab);
    ipcRenderer.on('platform:switch-tab', handler);
    return () => ipcRenderer.removeListener('platform:switch-tab', handler);
  }
});

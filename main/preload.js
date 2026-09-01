'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  cachedGuide: () => ipcRenderer.invoke('guide:cached'),
  playlistStatus: () => ipcRenderer.invoke('playlist:status'),
  sync: () => ipcRenderer.invoke('guide:sync'),
  refreshScores: () => ipcRenderer.invoke('guide:refreshScores'),
  vlcPlay: (url) => ipcRenderer.invoke('vlc:play', { url }),
  onProgress: (cb) => ipcRenderer.on('sync:progress', (_e, payload) => cb(payload)),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  choosePlaylist: () => ipcRenderer.invoke('playlist:choose'),
  chooseVlcPath: () => ipcRenderer.invoke('vlc:choose'),

  onUpdateReady: (cb) => ipcRenderer.on('update:ready', (_e, payload) => cb(payload)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});

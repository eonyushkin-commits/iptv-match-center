'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  cachedGuide: () => ipcRenderer.invoke('guide:cached'),
  playlistStatus: () => ipcRenderer.invoke('playlist:status'),
  choosePlaylist: () => ipcRenderer.invoke('playlist:choose'),
  getSources: () => ipcRenderer.invoke('sources:get'),
  saveSources: (data) => ipcRenderer.invoke('sources:save', data),
  revealConfig: () => ipcRenderer.invoke('config:reveal'),
  sync: () => ipcRenderer.invoke('guide:sync'),
  refreshScores: () => ipcRenderer.invoke('guide:refreshScores'),
  onProgress: (cb) => ipcRenderer.on('sync:progress', (_e, payload) => cb(payload)),
  vlcPlay: (url) => ipcRenderer.invoke('vlc:play', { url }),
});

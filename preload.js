/*
  ╔══════════════════════════════════════════════════════════════════╗
  ║  CHARON — Preload Script                                        ║
  ║  Context bridge: exposes safe IPC channels to the renderer      ║
  ╚══════════════════════════════════════════════════════════════════╝
*/

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('charon', {
  // ── Window controls ──
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // ── Python bridge commands ──
  bridge: (action, params) => ipcRenderer.invoke('bridge-command', action, params),

  // ── Search & Browse (via bridge) ──
  search: (query, type = 'track', limit = 50) =>
    ipcRenderer.invoke('bridge-command', 'search', { query, type, limit }),

  getArtist: (artistId) =>
    ipcRenderer.invoke('bridge-command', 'get_artist', { artist_id: artistId }),

  getAlbum: (albumId) =>
    ipcRenderer.invoke('bridge-command', 'get_album', { album_id: albumId }),

  getTrack: (trackId) =>
    ipcRenderer.invoke('bridge-command', 'get_track', { track_id: trackId }),

  getArtistAlbums: (artistId) =>
    ipcRenderer.invoke('bridge-command', 'get_artist_albums', { artist_id: artistId }),

  getArtistTopTracks: (artistId) =>
    ipcRenderer.invoke('bridge-command', 'get_artist_top_tracks', { artist_id: artistId }),

  // ── Auth ──
  authStatus: () =>
    ipcRenderer.invoke('bridge-command', 'auth_status'),

  authLogin: () =>
    ipcRenderer.invoke('bridge-command', 'auth_login'),

  // ── Download queue ──
  queueAdd: (item) => ipcRenderer.invoke('queue-add', item),
  queueRemove: (itemId) => ipcRenderer.invoke('queue-remove', itemId),
  queueGet: () => ipcRenderer.invoke('queue-get'),
  queueClearCompleted: () => ipcRenderer.invoke('queue-clear-completed'),

  // ── Navidrome ──
  navidromeScan: () => ipcRenderer.invoke('navidrome-scan'),

  // ── Settings ──
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (settings) => ipcRenderer.invoke('settings-set', settings),

  // ── System ──
  checkDeps: () => ipcRenderer.invoke('check-dependencies'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),

  // ── Event listeners ──
  onQueueUpdate: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('queue-update', handler);
    return () => ipcRenderer.removeListener('queue-update', handler);
  },

  onDownloadProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },

  onDownloadComplete: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('download-complete', handler);
    return () => ipcRenderer.removeListener('download-complete', handler);
  },

  onNavidromeScanResult: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('navidrome-scan-result', handler);
    return () => ipcRenderer.removeListener('navidrome-scan-result', handler);
  }
});

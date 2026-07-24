const { contextBridge, ipcRenderer } = require('electron');

// This preload file is the only bridge between the browser UI and Electron's
// main process. Keep exposed methods small and explicit: every new renderer
// action should call one named IPC channel handled in src/main/main.js.
contextBridge.exposeInMainWorld('liveTiming', {
  // Settings and storage actions.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  chooseFolder: () => ipcRenderer.invoke('storage:chooseFolder'),

  // Live collector controls.
  startCollector: (url) => ipcRenderer.invoke('collector:start', url),
  stopCollector: () => ipcRenderer.invoke('collector:stop'),
  getCollectorState: () => ipcRenderer.invoke('collector:getState'),
  openLiveWindow: () => ipcRenderer.invoke('collector:openLiveWindow'),
  openGraphsWindow: (carNumber) => ipcRenderer.invoke('graphs:open', carNumber),
  updateLapStatus: (payload) => ipcRenderer.invoke('laps:updateStatus', payload),

  // Keeps every open dashboard and graph window on the same saved theme.
  onThemeUpdate: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on('theme:update', listener);
    return () => ipcRenderer.removeListener('theme:update', listener);
  },

  // Creates timestamped export files from the current main-process state.
  exportCurrent: () => ipcRenderer.invoke('export:current'),

  // Subscribes the renderer to state pushes. The returned cleanup function is
  // important if this UI ever becomes component-based and listeners are mounted
  // or unmounted dynamically.
  onCollectorUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('collector:update', listener);
    return () => ipcRenderer.removeListener('collector:update', listener);
  }
});

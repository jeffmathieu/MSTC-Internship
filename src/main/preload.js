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

  // Built-in replay controls. Add matching ipcMain handlers before exposing new
  // replay actions here.
  startReplay: () => ipcRenderer.invoke('replay:start'),
  pauseReplay: () => ipcRenderer.invoke('replay:pause'),
  resumeReplay: () => ipcRenderer.invoke('replay:resume'),
  stopReplay: () => ipcRenderer.invoke('replay:stop'),

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

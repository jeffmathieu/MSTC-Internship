const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveTiming', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  chooseFolder: () => ipcRenderer.invoke('storage:chooseFolder'),
  startCollector: (url) => ipcRenderer.invoke('collector:start', url),
  stopCollector: () => ipcRenderer.invoke('collector:stop'),
  getCollectorState: () => ipcRenderer.invoke('collector:getState'),
  openLiveWindow: () => ipcRenderer.invoke('collector:openLiveWindow'),
  startReplay: () => ipcRenderer.invoke('replay:start'),
  pauseReplay: () => ipcRenderer.invoke('replay:pause'),
  resumeReplay: () => ipcRenderer.invoke('replay:resume'),
  stopReplay: () => ipcRenderer.invoke('replay:stop'),
  exportCurrent: () => ipcRenderer.invoke('export:current'),
  onCollectorUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('collector:update', listener);
    return () => ipcRenderer.removeListener('collector:update', listener);
  }
});

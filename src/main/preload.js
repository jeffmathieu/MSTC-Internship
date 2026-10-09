const { contextBridge, ipcRenderer } = require('electron');
// Self-contained for the sandboxed preload; contract tested against rendererState.
function mergeRendererState(previous = {}, payload = {}) {
  if (!payload.transportSequence) return payload;
  if (payload.transportSequence <= (previous.transportSequence || 0)) return previous;
  const apply = (old, patch) => patch ? [...(old || []).slice(0, patch.from), ...patch.items] : old || [];
  const { historyPatch, stripPatch, ...state } = payload;
  return { ...state, lapHistory: apply(previous.lapHistory, historyPatch), lapStrip: apply(previous.lapStrip, stripPatch) };
}

let rendererState = {};
const acceptState = (payload) => (rendererState = mergeRendererState(rendererState, payload));

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
  stopCollector: async () => {
    const result = await ipcRenderer.invoke('collector:stop');
    return { ...result, state: acceptState(result.state) };
  },
  getCollectorState: async () => acceptState(await ipcRenderer.invoke('collector:getState')),
  openLiveWindow: () => ipcRenderer.invoke('collector:openLiveWindow'),
  openGraphsWindow: (carNumber) => ipcRenderer.invoke('graphs:open', carNumber),
  updateFuel: async (payload) => {
    const result = await ipcRenderer.invoke('fuel:update', payload);
    return { ...result, state: acceptState(result.state) };
  },
  updateLapStatus: async (payload) => {
    const result = await ipcRenderer.invoke('laps:updateStatus', payload);
    return result.state ? { ...result, state: acceptState(result.state) } : result;
  },

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
    const listener = (_event, state) => callback(acceptState(state));
    ipcRenderer.on('collector:update', listener);
    return () => ipcRenderer.removeListener('collector:update', listener);
  }
});

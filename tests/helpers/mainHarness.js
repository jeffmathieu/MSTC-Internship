const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { EventEmitter } = require('events');

// Runs the real collector functions with an inert Electron shell. All data
// paths are explicit temporary session folders supplied by the test.
function mainHarness(folder) {
  const filename = path.resolve(__dirname, '../../src/main/main.js');
  const realRequire = createRequire(filename);
  const app = new EventEmitter();
  app.whenReady = () => new Promise(() => {});
  app.getPath = () => folder;
  const ipcMain = { handle() {} };
  const requireForTest = (name) => name === 'electron' ? { app, ipcMain, BrowserWindow: { getAllWindows: () => [] } }
    : name === 'electron-updater' ? { autoUpdater: {} } : realRequire(name);
  const source = fs.readFileSync(filename, 'utf8') + `\nreturn {
    buildAnalyticsSummary, normalizeSettings, normalizeSnapshot, normalizeRowsForStorage, updateLapHistory,
    updateServiceEvents, loadExistingHistory, rebuildCollectorDerivedState, updateStoredLapManualStatus, updateFuelSettingsAndState,
    getState: () => collectorState, setState: (value) => { collectorState = { ...collectorState, ...value }; },
    setSettings: (settings) => { loadSettings = () => normalizeSettings(settings); },
    flush: () => snapshotWriter.flush(), services: serviceStates, fuel: fuelStates
  };`;
  return new Function('require', '__dirname', source)(requireForTest, path.dirname(filename));
}
module.exports = { mainHarness };

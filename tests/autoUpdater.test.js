const assert = require('assert');
const { EventEmitter } = require('events');
const { setupAutoUpdates } = require('../src/main/autoUpdater');

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checkCount = 0;
  updater.installCount = 0;
  updater.checkForUpdates = async () => { updater.checkCount += 1; };
  updater.quitAndInstall = () => { updater.installCount += 1; };
  return updater;
}

const logEntries = [];
const logger = {
  info: (...args) => logEntries.push(['info', ...args]),
  error: (...args) => logEntries.push(['error', ...args])
};

const developmentUpdater = fakeUpdater();
assert.strictEqual(setupAutoUpdates({
  app: { isPackaged: false },
  dialog: {},
  autoUpdater: developmentUpdater,
  logger
}), false);
assert.strictEqual(developmentUpdater.checkCount, 0);
assert.strictEqual(developmentUpdater.listenerCount('update-downloaded'), 0);

const responses = [1, 0];
const dialogCalls = [];
const dialog = {
  showMessageBox: async (...args) => {
    dialogCalls.push(args);
    return { response: responses.shift() };
  }
};
const parentWindow = { name: 'main-window' };
const updater = fakeUpdater();
assert.strictEqual(setupAutoUpdates({
  app: { isPackaged: true, getVersion: () => '1.0.0' },
  dialog,
  autoUpdater: updater,
  getParentWindow: () => parentWindow,
  logger
}), true);

async function flushAsyncEvents() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

module.exports = (async () => {
  await flushAsyncEvents();
  assert.strictEqual(updater.checkCount, 1);
  assert.strictEqual(updater.autoDownload, true);
  assert.strictEqual(updater.autoInstallOnAppQuit, true);

  updater.emit('checking-for-update');
  updater.emit('update-available', { version: '1.1.0' });
  updater.emit('update-not-available', {});
  updater.emit('download-progress', { percent: 42.25, bytesPerSecond: 1200.7 });
  updater.emit('download-progress', {});
  updater.emit('error', new Error('network unavailable'));
  assert.ok(logEntries.some((entry) => String(entry[1]).includes('Checking for update')));
  assert.ok(logEntries.some((entry) => String(entry[1]).includes('42.3%')));
  assert.ok(logEntries.some((entry) => entry[0] === 'error'));

  updater.emit('update-downloaded', { version: '1.1.0' });
  await flushAsyncEvents();
  assert.strictEqual(updater.installCount, 0, 'Later keeps the current app running');
  assert.strictEqual(dialogCalls[0][0], parentWindow);

  updater.emit('update-downloaded', { version: '1.1.1' });
  await flushAsyncEvents();
  assert.strictEqual(updater.installCount, 1, 'Restart now installs the downloaded update');

  const noParentUpdater = fakeUpdater();
  setupAutoUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    dialog,
    autoUpdater: noParentUpdater,
    logger
  });
  noParentUpdater.emit('update-downloaded', { version: '1.2.0' });
  await flushAsyncEvents();
  assert.strictEqual(dialogCalls.at(-1).length, 1, 'dialog works when the main window is unavailable');

  console.log('Auto updater tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

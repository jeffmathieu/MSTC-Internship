const assert = require('assert');
const { EventEmitter } = require('events');
const { setupAutoUpdates } = require('../src/main/autoUpdater');

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checkCount = 0;
  updater.installCount = 0;
  updater.installArgs = [];
  updater.downloadCount = 0;
  updater.checkForUpdates = async () => { updater.checkCount += 1; };
  updater.downloadUpdate = async () => { updater.downloadCount += 1; };
  updater.quitAndInstall = (...args) => {
    updater.installCount += 1;
    updater.installArgs.push(args);
  };
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

const responses = [0, 1, 0];
const dialogCalls = [];
const dialog = {
  showMessageBox: async (...args) => {
    dialogCalls.push(args);
    return { response: responses.shift() };
  }
};
const parentWindow = { name: 'main-window' };
const updater = fakeUpdater();
let beforeInstallCalls = 0;
assert.strictEqual(setupAutoUpdates({
  app: { isPackaged: true, getVersion: () => '1.0.0' },
  dialog,
  autoUpdater: updater,
  getParentWindow: () => parentWindow,
  logger,
  onBeforeQuitAndInstall: () => { beforeInstallCalls += 1; }
}), true);

async function flushAsyncEvents() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

module.exports = (async () => {
  await flushAsyncEvents();
  assert.strictEqual(updater.checkCount, 1);
  assert.strictEqual(updater.autoDownload, false);
  assert.strictEqual(updater.autoInstallOnAppQuit, true);

  updater.emit('checking-for-update');
  updater.emit('update-available', { version: '1.1.0' });
  await flushAsyncEvents();
  assert.strictEqual(updater.downloadCount, 1, 'accepted available-update prompt starts the download');
  assert.strictEqual(dialogCalls[0][1].title, 'Update available');
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
  assert.strictEqual(dialogCalls[1][0], parentWindow);

  updater.emit('update-downloaded', { version: '1.1.1' });
  await flushAsyncEvents();
  await flushAsyncEvents();
  assert.strictEqual(beforeInstallCalls, 1, 'Restart now prepares app lifecycle before installing');
  assert.strictEqual(updater.installCount, 1, 'Restart now installs the downloaded update');
  assert.deepStrictEqual(updater.installArgs[0], [false, true], 'update install should force reopening after install');

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

  const declinedUpdater = fakeUpdater();
  setupAutoUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    autoUpdater: declinedUpdater,
    logger
  });
  declinedUpdater.emit('update-available');
  await flushAsyncEvents();
  assert.strictEqual(declinedUpdater.downloadCount, 0, 'Later does not download an available update');

  let releasePrompt;
  let duplicatePromptCount = 0;
  const duplicateUpdater = fakeUpdater();
  setupAutoUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    dialog: { showMessageBox: () => {
      duplicatePromptCount += 1;
      return new Promise((resolve) => { releasePrompt = resolve; });
    } },
    autoUpdater: duplicateUpdater,
    logger
  });
  duplicateUpdater.emit('update-available', { version: '2.0.0' });
  duplicateUpdater.emit('update-available', { version: '2.0.0' });
  await flushAsyncEvents();
  assert.strictEqual(duplicatePromptCount, 1, 'duplicate update events share one open prompt');
  releasePrompt({ response: 1 });
  await flushAsyncEvents();

  const downloadFailureUpdater = fakeUpdater();
  downloadFailureUpdater.downloadUpdate = async () => { throw new Error('download failed'); };
  setupAutoUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    autoUpdater: downloadFailureUpdater,
    logger
  });
  downloadFailureUpdater.emit('update-available', { version: '2.0.1' });
  await flushAsyncEvents();
  assert.ok(logEntries.some((entry) => String(entry[1]).includes('Update download failed')));

  const checkFailureUpdater = fakeUpdater();
  checkFailureUpdater.checkForUpdates = async () => { throw new Error('check failed'); };
  setupAutoUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    autoUpdater: checkFailureUpdater,
    logger
  });
  await flushAsyncEvents();
  assert.ok(logEntries.some((entry) => String(entry[1]).includes('Update check failed')));

  const installPromptFailureUpdater = fakeUpdater();
  setupAutoUpdates({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    dialog: { showMessageBox: async () => { throw new Error('dialog failed'); } },
    autoUpdater: installPromptFailureUpdater,
    logger
  });
  installPromptFailureUpdater.emit('update-downloaded', { version: '2.0.2' });
  await flushAsyncEvents();
  assert.strictEqual(installPromptFailureUpdater.installCount, 0);
  assert.ok(logEntries.some((entry) => String(entry[1]).includes('Update install prompt failed')));

  console.log('Auto updater tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

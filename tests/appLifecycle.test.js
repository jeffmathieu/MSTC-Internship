const assert = require('assert');
const { EventEmitter } = require('events');
const { setupAppLifecycle } = require('../src/main/appLifecycle');

function createFakeApp() {
  const app = new EventEmitter();
  app.quitCalls = 0;
  app.quit = () => { app.quitCalls += 1; };
  return app;
}

// Closing the main dashboard should quit on macOS too, rather than leaving the
// Electron process running in the Dock.
{
  const app = createFakeApp();
  const mainWindow = new EventEmitter();
  const lifecycle = setupAppLifecycle({ app, onBeforeQuit: () => {} });
  lifecycle.attachMainWindow(mainWindow);

  mainWindow.emit('closed');
  assert.strictEqual(app.quitCalls, 1);
}

// A Dock/menu Quit first enables real window closure. Subsequent window events
// must not recursively request another quit.
{
  const app = createFakeApp();
  const mainWindow = new EventEmitter();
  let cleanupCalls = 0;
  const lifecycle = setupAppLifecycle({
    app,
    onBeforeQuit: () => { cleanupCalls += 1; }
  });
  lifecycle.attachMainWindow(mainWindow);

  app.emit('before-quit');
  mainWindow.emit('closed');
  app.emit('window-all-closed');

  assert.strictEqual(cleanupCalls, 1);
  assert.strictEqual(lifecycle.isQuitting(), true);
  assert.strictEqual(app.quitCalls, 0);
}

// Keep a fallback for unusual paths where all windows close without the main
// window's closed event being observed first.
{
  const app = createFakeApp();
  setupAppLifecycle({ app, onBeforeQuit: () => {} });

  app.emit('window-all-closed');
  assert.strictEqual(app.quitCalls, 1);
}

console.log('appLifecycle tests passed');

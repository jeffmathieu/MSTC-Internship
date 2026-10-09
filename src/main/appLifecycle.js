// Centralizes Electron shutdown behavior so hidden collector windows cannot
// accidentally keep the application alive or cancel a macOS Quit command.
function setupAppLifecycle({ app, onBeforeQuit, onError = () => {} }) {
  let isQuitting = false;
  let draining = null;

  function beginQuit(event) {
    if (isQuitting) {
      if (draining) event?.preventDefault();
      return draining;
    }
    isQuitting = true;
    const result = onBeforeQuit();
    if (result && typeof result.then === 'function') {
      event?.preventDefault();
      draining = Promise.resolve(result).catch(onError).finally(() => {
        draining = null;
        if (event) app.quit();
      });
    }
    return draining;
  }

  app.on('before-quit', beginQuit);

  // Closing the main dashboard means the user is finished with the app. This
  // intentionally differs from the usual macOS behavior of staying in the Dock.
  function attachMainWindow(window) {
    window.on('closed', () => {
      if (!isQuitting) app.quit();
    });
  }

  // Also cover the case where every window disappears through another route.
  app.on('window-all-closed', () => {
    if (!isQuitting) app.quit();
  });

  return {
    attachMainWindow,
    beginQuit,
    isQuitting: () => isQuitting
  };
}

module.exports = { setupAppLifecycle };

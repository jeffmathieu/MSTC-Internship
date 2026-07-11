// Centralizes Electron shutdown behavior so hidden collector windows cannot
// accidentally keep the application alive or cancel a macOS Quit command.
function setupAppLifecycle({ app, onBeforeQuit }) {
  let isQuitting = false;

  function beginQuit() {
    if (isQuitting) return;
    isQuitting = true;
    onBeforeQuit();
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

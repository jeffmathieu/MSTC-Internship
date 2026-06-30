// Packaged-app update lifecycle.
//
// Keeping this separate from main.js makes the production-only guard and user
// prompt testable without disturbing window creation, polling, or IPC code.
function setupAutoUpdates({ app, dialog, autoUpdater, getParentWindow = () => null, logger = console }) {
  if (!app?.isPackaged) {
    logger.info('[auto-update] Disabled during local development.');
    return false;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => logger.info('[auto-update] Checking for update.'));
  autoUpdater.on('update-available', (info) => logger.info(`[auto-update] Update available: ${info?.version || 'unknown version'}.`));
  autoUpdater.on('update-not-available', (info) => logger.info(`[auto-update] App is current (${info?.version || app.getVersion()}).`));
  autoUpdater.on('error', (error) => logger.error('[auto-update] Update error:', error));
  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent);
    const speed = Number(progress?.bytesPerSecond);
    logger.info(`[auto-update] Download ${Number.isFinite(percent) ? percent.toFixed(1) : '?'}% (${Number.isFinite(speed) ? Math.round(speed) : '?'} B/s).`);
  });
  autoUpdater.on('update-downloaded', async (info) => {
    logger.info(`[auto-update] Update downloaded: ${info?.version || 'unknown version'}.`);
    const options = {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Update ready',
      message: `MSTC Race Engineer Dashboard ${info?.version || ''} is ready to install.`,
      detail: 'Restart now to install the update, or choose Later to keep working. It will install when the app closes.'
    };
    const parent = getParentWindow();
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdates().catch((error) => logger.error('[auto-update] Update check failed:', error));
  return true;
}

module.exports = { setupAutoUpdates };

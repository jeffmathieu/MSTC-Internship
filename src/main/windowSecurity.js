const path = require('path');
const { fileURLToPath } = require('url');

function localPageAllowed(url, rendererFolder) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    return ['index.html', 'graphs.html'].some((name) => fileURLToPath(parsed) === path.join(rendererFolder, name));
  } catch { return false; }
}

function remoteNavigationAllowed(url, initialUrl) {
  try {
    const next = new URL(url), initial = new URL(initialUrl);
    return ['http:', 'https:'].includes(next.protocol) && !next.username && !next.password
      && (next.origin === initial.origin || (initial.protocol === 'http:' && next.protocol === 'https:' && next.hostname === initial.hostname));
  } catch { return false; }
}

function secureContents(contents, allowed) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}

function trustedSender(event, windows, rendererFolder) {
  return Boolean(event?.sender && event.senderFrame && event.senderFrame === event.sender.mainFrame
    && windows.some((win) => win && !win.isDestroyed() && win.webContents === event.sender)
    && localPageAllowed(event.senderFrame.url, rendererFolder));
}

module.exports = { localPageAllowed, remoteNavigationAllowed, secureContents, trustedSender };

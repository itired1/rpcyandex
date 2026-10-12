'use strict';

/**
 * Locates the client's own BrowserWindow.
 *
 * The window is created by the vanilla `createWindow()`, which we cannot call
 * or patch, so we observe window creation instead. The reliable discriminator
 * is the renderer URL: the application window loads `music-application://desktop`,
 * while the Yandex Passport login window loads an `https://oauth.yandex.*` URL.
 */

const APP_URL_PREFIX = 'music-application://desktop';

/** @returns {boolean} true for the main music window, false for auth windows. */
function isApplicationUrl(url) {
  return typeof url === 'string' && url.startsWith(APP_URL_PREFIX);
}

function findApplicationWindow(electron) {
  return electron.BrowserWindow.getAllWindows().find((win) => isApplicationUrl(win.webContents?.getURL())) ?? null;
}

/**
 * Calls `onWindow` once per application window, as soon as its URL proves what
 * it is. Returns a disposer.
 */
function watchApplicationWindows(electron, onWindow, logger) {
  const seen = new WeakSet();

  const consider = (win) => {
    if (!win || win.isDestroyed() || seen.has(win)) return;
    if (!isApplicationUrl(win.webContents?.getURL())) return;
    seen.add(win);
    logger.info('Application window detected:', win.webContents.getURL());
    onWindow(win);
  };

  const created = (_event, win) => {
    for (const eventName of ['did-navigate', 'did-navigate-in-page', 'did-finish-load']) {
      win.webContents.on(eventName, () => consider(win));
    }
    win.once('closed', () => logger.info('Application window closed'));
    consider(win);
  };

  electron.app.on('browser-window-created', created);

  // Cover the case where a window already existed when the bootstrap ran.
  electron.app.whenReady().then(() => {
    for (const win of electron.BrowserWindow.getAllWindows()) created(null, win);
  });

  return () => electron.app.removeListener('browser-window-created', created);
}

module.exports = { isApplicationUrl, findApplicationWindow, watchApplicationWindows, APP_URL_PREFIX };

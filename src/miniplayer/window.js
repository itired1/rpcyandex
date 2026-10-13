'use strict';

/**
 * Mini player window.
 *
 * A separate frameless BrowserWindow that mirrors the current track and drives
 * playback. It talks to the main process over its own `itirpc:mini:*` channels
 * via `preload.js`, so no part of the client's renderer is involved.
 *
 * The window hides instead of closing: reopening it is instant, and it keeps
 * the "pin above other windows" state the user chose.
 */

const path = require('node:path');
const electron = require('electron');
const { CHANNELS } = require('./channels');

/**
 * Window floor.
 *
 * Not arbitrary: this is the smallest box the *minimal* layout in index.css can
 * render without clipping. The layout used to need ~120px and the floor was 96,
 * so `overflow: hidden` quietly cut off the bottom of the controls. Redrawing
 * the minimal tier for a shorter box brought the floor down to 72 in turn; the
 * figure is not guesswork, the layout sweep in scripts/run-tests.mjs resolves
 * the stylesheet's clamp()s for every size from here to 600x280 and fails if any
 * of them overflows.
 */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 72;

/** Matches the `:root` colours in index.css, per colour scheme. */
const CHROME_BG = { dark: '#16181c', light: '#f6f7f9' };

class MiniPlayer {
  constructor({ settings, player, zoom, logger, onOpenSettings }) {
    this.settings = settings;
    this.player = player;
    this.zoom = zoom;
    this.logger = logger;
    this.onOpenSettings = onOpenSettings;
    this.window = null;
    this.ready = false;
    this.boundIpc = false;
  }

  get config() {
    return this.settings.get('miniplayer') ?? {};
  }

  toggle() {
    if (this.window && this.window.isVisible()) this.hide();
    else this.show();
  }

  show() {
    if (!this.config.enabled) {
      this.logger.warn('Mini player is disabled in settings');
      return;
    }
    // A BrowserWindow cannot be constructed before the app is ready.
    if (!electron.app.isReady()) {
      this.logger.warn('Mini player requested before the app was ready; ignoring');
      return;
    }
    if (!this.window || this.window.isDestroyed()) this.#create();
    this.window.show();
    this.window.focus();
    this.#pushState(true);
  }

  hide() {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  dispose() {
    if (this.rememberTimer) clearTimeout(this.rememberTimer);
    this.rememberTimer = null;
    if (this.window && !this.window.isDestroyed()) {
      this.#releaseZoom();
      this.window.removeAllListeners();
      this.window.destroy();
    }
    this.window = null;
  }

  #releaseZoom() {
    if (!this.zoom || !this.window) return;
    this.zoom.detach(this.window.webContents);
  }

  /**
   * Chromium paints a window's background before the document loads, so the
   * colour has to match the stylesheet. A hardcoded dark value flashed black on
   * a light system theme, which is why it follows `nativeTheme` instead.
   */
  #backgroundColor() {
    const dark = electron.nativeTheme?.shouldUseDarkColors !== false;
    return dark ? CHROME_BG.dark : CHROME_BG.light;
  }

  #create() {
    const config = this.config;
    const position = this.#rememberedPosition();

    const window = new electron.BrowserWindow({
      width: Number(config.width) || 340,
      height: Number(config.height) || 132,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      ...position,
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: Boolean(config.alwaysOnTop),
      skipTaskbar: false,
      show: false,
      backgroundColor: this.#backgroundColor(),
      title: 'itirpc mini player',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    window.loadFile(path.join(__dirname, 'index.html'));

    // The mini player is our own renderer, so it honours the same zoom factor as
    // the client. Without this a 9px caption stayed 9px on a 200% display.
    this.zoom?.attach(window.webContents);

    const onThemeChange = () => {
      if (!window.isDestroyed()) window.setBackgroundColor(this.#backgroundColor());
    };
    electron.nativeTheme?.on('updated', onThemeChange);
    window.once('closed', () => {
      electron.nativeTheme?.removeListener('updated', onThemeChange);
      this.#releaseZoom();
    });

    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show();
    });
    window.on('closed', () => {
      this.window = null;
      this.ready = false;
    });
    // Persist size and position so the window comes back where it was.
    // Dragging fires `moved` continuously, so writes are debounced: each write
    // touches config.json and wakes the settings watcher.
    const remember = () => this.#scheduleRememberBounds();
    window.on('resized', remember);
    window.on('moved', remember);

    this.window = window;
    this.#bindIpc();
    this.logger.info('Mini player window created');
  }

  #scheduleRememberBounds() {
    if (this.rememberTimer) clearTimeout(this.rememberTimer);
    this.rememberTimer = setTimeout(() => {
      this.rememberTimer = null;
      this.#rememberBounds();
    }, 750);
  }

  #rememberedPosition() {
    const { x, y } = this.config;
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : {};
  }

  #rememberBounds() {
    if (!this.window || this.window.isDestroyed()) return;
    const bounds = this.window.getBounds();
    // Only geometry belongs to settings here; other miniplayer keys may have
    // changed since the window was created.
    for (const key of ['x', 'y', 'width', 'height']) {
      this.settings.set(`miniplayer.${key}`, bounds[key]);
    }
  }

  /**
   * Channels are registered once: the window can be recreated many times, and
   * duplicate `ipcMain` listeners would multiply every command.
   */
  #bindIpc() {
    if (this.boundIpc) return;
    this.boundIpc = true;

    electron.ipcMain.on(CHANNELS.COMMAND, (event, command) => {
      if (!this.#isFromMiniPlayer(event)) return;
      this.#handleCommand(command);
    });

    electron.ipcMain.on(CHANNELS.READY, (event) => {
      if (!this.#isFromMiniPlayer(event)) return;
      this.ready = true;
      // Proof that the renderer, its stylesheet and its script all loaded.
      this.logger.info('Mini player renderer ready');
      this.#pushState(true);
    });

    electron.ipcMain.on(CHANNELS.RESIZE, (event, size) => {
      if (!this.#isFromMiniPlayer(event)) return;
      if (!this.window || this.window.isDestroyed()) return;
      const width = Math.max(MIN_WIDTH, Math.round(Number(size?.width) || 0));
      const height = Math.max(MIN_HEIGHT, Math.round(Number(size?.height) || 0));
      const bounds = this.window.getBounds();
      if (bounds.width === width && bounds.height === height) return;
      this.window.setBounds({ ...bounds, width, height });
    });

    this.player.on('state', () => this.#pushState(false));
  }

  /** Only our own mini player window may drive playback through this bridge. */
  #isFromMiniPlayer(event) {
    return Boolean(this.window) && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  #handleCommand(command) {
    switch (command?.action) {
      case 'toggle':
        this.player.togglePlay();
        break;
      case 'next':
        this.player.next();
        break;
      case 'previous':
        this.player.previous();
        break;
      case 'volumeUp':
        this.player.adjustVolume(0.05);
        break;
      case 'volumeDown':
        this.player.adjustVolume(-0.05);
        break;
      case 'seek':
        this.player.seek(Number(command.value) || 0);
        break;
      case 'togglePin': {
        if (!this.window || this.window.isDestroyed()) return;
        const next = !this.window.isAlwaysOnTop();
        this.window.setAlwaysOnTop(next);
        this.settings.set('miniplayer.alwaysOnTop', next);
        this.logger.info('Mini player always-on-top:', next);
        this.#pushState(true);
        break;
      }
      case 'hide':
        this.hide();
        break;
      case 'openSettings':
        if (this.onOpenSettings) this.onOpenSettings();
        break;
      default:
        this.logger.warn('Unknown mini player command:', command);
    }
  }

  /** Sends the current player state to the mini player renderer. */
  #pushState(force) {
    if (!this.window || this.window.isDestroyed()) return;
    if (!this.ready && !force) return;
    const state = this.player.state ?? {};

    // The badge is composed here so the renderer stays a dumb view.
    let codec = null;
    if (this.settings.get('ui.showCodec') && state.codec) {
      codec = state.bitrateKbps ? `${state.codec} ${state.bitrateKbps}` : state.codec;
    }

    this.window.webContents.send(CHANNELS.STATE, {
      hasTrack: Boolean(state.hasTrack),
      title: state.title ?? null,
      artist: state.artist ?? null,
      album: state.album ?? null,
      coverUrl: state.coverUrl ?? null,
      isPlaying: Boolean(state.isPlaying),
      duration: state.duration ?? null,
      position: state.position ?? null,
      codec,
      alwaysOnTop: this.window.isAlwaysOnTop(),
    });
  }
}

module.exports = { MiniPlayer, MIN_WIDTH, MIN_HEIGHT, CHROME_BG };

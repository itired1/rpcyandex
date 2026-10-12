'use strict';

/**
 * JSON-backed settings store with defaults and change notification.
 *
 * Deliberately dependency-free: the mod ships inside the client's app.asar and
 * must not rely on the client's own node_modules staying compatible.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  discord: {
    enabled: true,
    /**
     * Discord application id. Users must create their own application in the
     * Discord Developer Portal — shipping someone else's clientId would mean
     * publishing under their app identity.
     */
    clientId: '',
    /** 'details' — title + artist/album, 'album' — title + album, 'minimal' — title only. */
    displayType: 'details',
    /** 'auto' follows the client locale, 'ru' and 'en' force one. */
    language: 'auto',
    /** Clear the presence after this many minutes paused; 0 disables it. */
    idleTimeoutMinutes: 15,
    /** Seconds between reconnect attempts when Discord is not reachable. */
    reconnectIntervalSeconds: 30,
    showButtons: true,
    showTimestamps: true,
    /**
     * Discord asset key for the small icon. Only works if the key was uploaded
     * to the application, so it stays empty by default.
     */
    smallImageKey: '',
    /**
     * Which line Discord shows next to the app name: 0 = app, 1 = details,
     * 2 = state. Set to null to omit the field on older Discord builds.
     */
    statusDisplayType: 2,
  },
  lastfm: {
    enabled: false,
    apiKey: '',
    sharedSecret: '',
    sessionKey: '',
    username: '',
    /** Scrobble percentage of the track required before submitting. */
    scrobbleThresholdPercent: 50,
  },
  hotkeys: {
    enabled: true,
    playPause: 'Control+/',
    next: 'Control+Right',
    previous: 'Control+Left',
    volumeUp: 'Control+Up',
    volumeDown: 'Control+Down',
    /** Opens the mini player. Ctrl+Shift+M is Discord's mute shortcut. */
    miniPlayer: 'Control+Alt+M',
    /** Application zoom, mirroring the browser conventions. */
    zoomIn: 'Control+=',
    zoomOut: 'Control+-',
    zoomReset: 'Control+0',
  },
  ui: {
    /** Persisted zoom factor, 1 = 100 %. */
    zoom: 1,
    /** Adds a separate itirpc icon next to the client's own tray icon. */
    trayIcon: true,
    /** Show the current stream codec in the mini player. */
    showCodec: true,
  },
  miniplayer: {
    enabled: true,
    alwaysOnTop: true,
    /** Show the window automatically once the client window is ready. */
    openOnStart: false,
    width: 340,
    height: 132,
    /** Remembered position; empty means "let the OS place it". */
    x: null,
    y: null,
  },
  cache: {
    /** Empty means the client default (%APPDATA%/YandexMusic). */
    directory: '',
  },
  downloads: {
    /**
     * Off by default, and deliberately so.
     *
     * The client's stream is encrypted — the URL path contains `/music-v2/crypt/`
     * and the payload has no container header at all (verified live: no `ftyp`,
     * `moov`, `mdat` or `ID3` in the first 2 MiB). Saving it verbatim produces a
     * file no player can open, so the feature stays off rather than shipping
     * something that looks like it works. Making it playable would mean
     * reimplementing Yandex's content protection, which is out of scope here.
     */
    enabled: false,
    /** Empty means <Music>/itirpc. */
    directory: '',
    /** Requires ffmpeg; without it the original stream format is kept. */
    convertToMp3: false,
    /** Explicit ffmpeg path; empty means "look it up in PATH". */
    ffmpegPath: '',
  },
  debug: {
    logLevel: 'info',
    /** Dumps raw mediaSession snapshots to the log; used to verify extraction. */
    dumpPlayerState: false,
    /**
     * One-shot action executed when the value changes, for automating checks
     * that would otherwise need a tray click inside a GUI app.
     * Supported: download-current, miniplayer-toggle, zoom-reset, dump-state.
     */
    command: '',
  },
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeDefaults(defaults, value) {
  if (!isPlainObject(defaults)) return value === undefined ? defaults : value;
  const out = {};
  for (const [key, def] of Object.entries(defaults)) {
    out[key] = isPlainObject(value) && key in value ? mergeDefaults(def, value[key]) : def;
  }
  if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) if (!(key in out)) out[key] = val;
  }
  return out;
}

class Settings {
  constructor(filePath) {
    this.filePath = filePath;
    this.listeners = new Set();
    const existed = fs.existsSync(filePath);
    this.data = this.#load();
    // Materialise the file on first run so users can find and edit it instead
    // of discovering that settings only appear after something changes them.
    if (!existed) this.save();
    this.#watch();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return mergeDefaults(DEFAULT_SETTINGS, JSON.parse(raw));
    } catch {
      return mergeDefaults(DEFAULT_SETTINGS, {});
    }
  }

  /**
   * Picks up edits made by hand while the client is running, so users do not
   * have to restart after changing the config file.
   *
   * The mod writes this file itself (for example when the mini player window is
   * moved), and those writes trigger the watcher too. Comparing the parsed
   * result against the in-memory copy filters them out, which matters because
   * listeners re-register global hotkeys and that is expensive.
   */
  #watch() {
    try {
      const watcher = fs.watch(this.filePath, { persistent: false }, () => {
        const next = this.#load();
        if (JSON.stringify(next) === JSON.stringify(this.data)) return;
        this.data = next;
        for (const listener of this.listeners) {
          try {
            listener(next);
          } catch {
            // A broken listener must not stop the others.
          }
        }
      });

      // fs.watch reports failures asynchronously. Without this handler an
      // unreadable or deleted config file (a network profile, an editor that
      // replaces the file) emits an unhandled 'error' event, which would take
      // the whole client down. Settings stay usable in memory instead.
      watcher.on('error', () => {
        this.watching = false;
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
      });

      this.watcher = watcher;
      this.watching = true;
    } catch {
      // fs.watch is unavailable on some filesystems; polling is not worth it.
      this.watching = false;
    }
  }

  /** Stops watching the file. Safe to call more than once. */
  dispose() {
    this.watching = false;
    try {
      this.watcher?.close();
    } catch {
      // Already closed or never opened.
    }
    this.watcher = null;
    this.listeners.clear();
  }

  get(path) {
    return path.split('.').reduce((acc, key) => (isPlainObject(acc) ? acc[key] : undefined), this.data);
  }

  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let cursor = this.data;
    for (const key of keys) {
      if (!isPlainObject(cursor[key])) cursor[key] = {};
      cursor = cursor[key];
    }
    // Writing an unchanged value would still touch the file and wake the
    // watcher, so short-circuit instead.
    if (JSON.stringify(cursor[last]) === JSON.stringify(value)) return false;
    cursor[last] = value;
    this.save();
    return true;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    } catch {
      // Best effort: a read-only profile directory should not break playback.
    }
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  static get defaults() {
    return DEFAULT_SETTINGS;
  }
}

module.exports = { Settings, DEFAULT_SETTINGS };

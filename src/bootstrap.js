'use strict';

/**
 * itirpc bootstrap — the single entry point injected into the client's main
 * process by `toolset.js`.
 *
 * The patch is one line at the top of the vanilla `index.js`:
 *
 *     'use strict';require('./itirpc/bootstrap.js');const electron=require('electron')...
 *
 * From here the mod only uses public Electron APIs and the client's existing
 * IPC channels, which is what keeps it working across client updates.
 *
 * Nothing in this file may throw: a failure here would take the whole client
 * down, so every subsystem is isolated.
 */

const path = require('node:path');
const electron = require('electron');

// Written before any other require so that a startup failure anywhere below is
// still distinguishable from "the patched archive never loaded at all".
const { trace, traceError } = require('./core/boot-trace');
trace('bootstrap.js loaded');
trace({
  electron: process.versions.electron,
  node: process.versions.node,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath,
  argv: process.argv.slice(1),
});

const loggerModule = require('./core/logger');
const { Settings } = require('./core/settings');
const { watchApplicationWindows, findApplicationWindow } = require('./core/app-window');
const { PlayerMonitor } = require('./player/player-monitor');
const { DiscordPresence } = require('./discord/presence');
const { HotkeyManager } = require('./core/hotkeys');
const { ZoomController } = require('./core/zoom');
const { MiniPlayer } = require('./miniplayer/window');
const { ModTray } = require('./ui/tray');
const { LastFmScrobbler } = require('./lastfm/scrobbler');
const { SettingsWindow } = require('./settings-ui/window');
const { Downloader } = require('./downloads/downloader');
const { createSessionTransport } = require('./downloads/transport');

const MOD_ID = 'itirpc';
const MOD_VERSION = '0.1.0';

const log = loggerModule.create('Bootstrap');

function resolveDataDir() {
  try {
    return path.join(electron.app.getPath('userData'), MOD_ID);
  } catch {
    const appData = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
    return path.join(appData, 'YandexMusic', MOD_ID);
  }
}

/** Everything the mod owns lives here, so a single directory can be reset. */
let dataDir;
try {
  dataDir = resolveDataDir();
  trace(`dataDir resolved: ${dataDir}`);
} catch (error) {
  traceError('resolveDataDir', error);
  dataDir = path.join(process.cwd(), MOD_ID);
}

let settings;
let player;
let presence;
let hotkeys;
let miniPlayer;
let tray;
let lastfm;
let zoom;
let downloads;
let settingsWindow;
let disposeWindowWatcher;

/** Safe wrapper: a throwing subsystem is logged and skipped, never fatal. */
function guard(name, fn) {
  try {
    return fn();
  } catch (error) {
    traceError(`subsystem:${name}`, error);
    log.error(`Subsystem "${name}" failed to start:`, error);
    return null;
  }
}

/**
 * Runs `fn` once the app is ready.
 *
 * The bootstrap is required from the first line of the client's index.js, which
 * is well before `app.whenReady()`. `globalShortcut`, `Tray` and `BrowserWindow`
 * all throw if used too early, and whether ready has already fired by the time
 * this code runs is a race, so anything that needs it must be deferred.
 */
function whenAppReady(fn, label) {
  if (electron.app.isReady()) {
    guard(label, fn);
    return;
  }
  electron.app.whenReady().then(
    () => guard(label, fn),
    (error) => log.error(`Subsystem "${label}" never started:`, error),
  );
}

function describeTrack(state) {
  const parts = [state.title ?? '—'];
  if (state.artist) parts.push(`— ${state.artist}`);
  if (state.album) parts.push(`[${state.album}]`);
  const progress =
    typeof state.position === 'number' && typeof state.duration === 'number'
      ? ` ${state.position.toFixed(1)}/${state.duration.toFixed(1)}s`
      : '';
  return `${parts.join(' ')}${progress} (${state.isPlaying ? 'playing' : 'paused'})`;
}

/** Debug commands accepted by `debug.command`; see runDebugCommand. */
const DEBUG_COMMANDS = [
  'download-current',
  'miniplayer-toggle',
  'settings-open',
  'zoom-reset',
  'dump-state',
  'toggle-play',
  'next-track',
];

function startPlayerTracking(win) {
  player.attach(win.webContents);
  // Zoom is per-origin Chromium state, so it has to be re-applied to the
  // renderer that is actually showing the app.
  zoom?.attach(win.webContents);

  // NOTE: this used to install a `webRequest.onBeforeRequest` listener to catch
  // audio URLs on the network layer. That is deliberately gone. Electron allows
  // one listener per webRequest event, and the host pattern needed for sharded
  // stream hosts (`*.mds.yandex.net`) also matched `avatars.mds.yandex.net`,
  // which serves artwork and parts of the UI. Intercepting those requests broke
  // images and layout in the client. The stream URL is already available from
  // the media element and from the renderer's resource timing buffer, so no
  // network interception is needed at all.

  // Downloads reuse the window's session so the stream is fetched with the
  // account's own cookies. The transport itself is Node's, not Electron's —
  // see the comment on createSessionTransport for why.
  guard('downloads-transport', () => {
    if (!downloads) return null;
    downloads.transport = createSessionTransport(win.webContents.session);
    return downloads;
  });

  player.on('track', (state) => {
    log.info('Track:', describeTrack(state));
    if (state.coverUrl) log.debug('Cover:', state.coverUrl);
  });

  player.on('state', (state) => {
    // Read live so toggling the setting takes effect without a restart.
    if (settings.get('debug.dumpPlayerState')) log.debug('Snapshot:', state.raw);
  });

  player.on('playback', (state) => {
    log.info('Playback:', state.isPlaying ? 'playing' : 'paused', '|', describeTrack(state));
  });

  if (settings.get('debug.dumpPlayerState')) {
    log.debug('Snapshot dump enabled; raw probe payloads will be logged');
  }

  if (settings.get('miniplayer.openOnStart')) {
    guard('miniplayer-autoshow', () => miniPlayer?.show());
  }
}

/**
 * Runs a one-shot action named in `debug.command`.
 *
 * Verifying a mod that lives inside a GUI application is awkward: there is no
 * way to click its tray menu from a script. This hook makes the same code paths
 * reachable by writing to config.json, which the settings watcher already
 * picks up. Only the commands listed here can run.
 */
function runDebugCommand(command) {
  const state = player?.state;
  switch (command) {
    case 'download-current': {
      if (!state?.streamUrl) {
        log.warn('debug.command: no stream URL yet — start playback first');
        return;
      }
      log.info(`debug.command: downloading "${state.title}" from ${state.streamUrl}`);
      downloads
        ?.download({ title: state.title, artist: state.artist, album: state.album }, state.streamUrl)
        .then((result) =>
          log.info('debug.command: download result', {
            ok: result.ok,
            path: result.path,
            bytes: result.bytes,
            error: result.error,
          }),
        );
      return;
    }
    case 'miniplayer-toggle':
      miniPlayer?.toggle();
      log.info('debug.command: mini player toggled');
      return;
    case 'settings-open':
      settingsWindow?.show();
      log.info('debug.command: settings window opened');
      return;
    case 'toggle-play':
      // Reaches the same path as the tray and the global hotkey.
      log.info('debug.command: toggle play ->', player?.togglePlay());
      return;
    case 'next-track':
      log.info('debug.command: next track ->', player?.next());
      return;
    case 'zoom-reset':
      zoom?.reset();
      return;
    case 'dump-state':
      log.info('debug.command: player state', state);
      log.info('debug.command: last observed stream', player?.observedStreamUrl ?? null);
      return;
    default:
      log.warn(`debug.command: unknown command "${command}"`);
  }
}

function main() {
  loggerModule.configure({
    dir: path.join(dataDir, 'logs'),
    level: 'debug',
  });

  log.info(`itirpc ${MOD_VERSION} starting`);
  log.info(`Data directory: ${dataDir}`);
  log.info(`Client: ${electron.app.getName()} ${electron.app.getVersion()}`);
  log.info(`Log file: ${loggerModule.file}`);
  trace(`logger ready: ${loggerModule.file}`);

  settings = guard('settings', () => new Settings(path.join(dataDir, 'config.json')));
  if (!settings) return;
  log.info('Settings loaded from', settings.filePath);

  // Re-runs the debug command whenever its value in config.json changes.
  let lastCommand = settings.get('debug.command') ?? '';
  settings.onChange(() => {
    const command = settings.get('debug.command') ?? '';
    if (!command || command === lastCommand) return;
    lastCommand = command;
    guard('debug-command', () => runDebugCommand(command));
  });

  player = guard('player', () => new PlayerMonitor({ logger: loggerModule.create('Player') }));
  if (!player) return;

  // Zoom is bound to more than one renderer (the client window and the mini
  // player), so it is created before either of them.
  zoom = guard(
    'zoom',
    () => {
      const controller = new ZoomController({
        settings,
        logger: loggerModule.create('Zoom'),
      });
      controller.watch();
      return controller;
    },
  );

  miniPlayer = guard(
    'miniplayer',
    () =>
      new MiniPlayer({
        settings,
        player,
        zoom,
        logger: loggerModule.create('MiniPlayer'),
      }),
  );

  presence = guard(
    'discord',
    () =>
      new DiscordPresence({
        settings,
        player,
        logger: loggerModule.create('Discord'),
        locale: electron.app.getLocale(),
      }),
  );

  lastfm = guard(
    'lastfm',
    () => new LastFmScrobbler({ settings, player, logger: loggerModule.create('LastFm') }),
  );

  downloads = guard(
    'downloads',
    () =>
      new Downloader({
        settings,
        logger: loggerModule.create('Downloads'),
        // The transport needs the window's session, so it is attached later;
        // until then a download request reports that clearly.
        transport: null,
      }),
  );

  // The settings panel owns no state of its own: it reads and writes the same
  // store every other subsystem uses, so changes apply live.
  settingsWindow = guard(
    'settings-window',
    () =>
      new SettingsWindow({
        settings,
        presence,
        scrobbler: lastfm,
        hotkeys,
        miniPlayer,
        zoom,
        downloads,
        player,
        dataDir,
        version: MOD_VERSION,
        logger: loggerModule.create('Settings'),
      }),
  );

  // Created before the hotkeys so the mini-player shortcut has something to
  // toggle even when the window is only built on first use.
  hotkeys = guard(
    'hotkeys',
    () =>
      new HotkeyManager({
        settings,
        player,
        miniPlayer,
        zoom,
        logger: loggerModule.create('Hotkeys'),
      }),
  );

  tray = guard(
    'tray',
    () =>
      new ModTray({
        settings,
        presence,
        hotkeys,
        miniPlayer,
        lastfm,
        zoom,
        downloads,
        player,
        settingsWindow,
        logger: loggerModule.create('Tray'),
        dataDir,
        version: MOD_VERSION,
      }),
  );

  // These three need a ready app: globalShortcut and Tray throw before it, and
  // the presence connects a socket whose reconnect loop should not race startup.
  whenAppReady(() => presence?.start(), 'discord-start');
  whenAppReady(() => lastfm?.start(), 'lastfm-start');
  whenAppReady(() => hotkeys?.start(), 'hotkeys-start');
  whenAppReady(() => tray?.start(), 'tray-start');

  // The player state stream is what every feature reacts to, so it is attached
  // even when Discord is disabled — the mini player and scrobbling share it.
  disposeWindowWatcher = guard('window-watcher', () =>
    watchApplicationWindows(electron, startPlayerTracking, loggerModule.create('Window')),
  );

  // The window may already exist if the bootstrap is ever loaded late.
  electron.app.whenReady().then(() => {
    const existing = guard('existing-window', () => findApplicationWindow(electron));
    if (existing) startPlayerTracking(existing);
  });

  electron.app.on('will-quit', () => {
    try {
      disposeWindowWatcher?.();
      tray?.dispose();
      presence?.stop();
      lastfm?.stop();
      hotkeys?.stop();
      miniPlayer?.dispose();
      settingsWindow?.dispose();
      player?.dispose();
      zoom?.dispose();
    } catch (error) {
      log.error('Shutdown error:', error);
    }
  });
}

guard('main', main);
trace('bootstrap.js finished');

module.exports = {
  MOD_ID,
  MOD_VERSION,
  get settings() {
    return settings;
  },
  get player() {
    return player;
  },
  get presence() {
    return presence;
  },
  get hotkeys() {
    return hotkeys;
  },
  get miniPlayer() {
    return miniPlayer;
  },
};

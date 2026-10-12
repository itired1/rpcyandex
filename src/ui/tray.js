'use strict';

/**
 * itirpc tray icon.
 *
 * The vanilla client builds its own tray menu inside a minified function, so
 * appending to it would mean patching that code and re-patching it on every
 * client update. A second, clearly labelled icon is the non-invasive option and
 * is where the mod's toggles live.
 */

const path = require('node:path');
const electron = require('electron');

class ModTray {
  constructor({
    settings,
    presence,
    hotkeys,
    miniPlayer,
    lastfm,
    zoom,
    downloads,
    player,
    settingsWindow,
    logger,
    dataDir,
    version,
  }) {
    this.settings = settings;
    this.presence = presence;
    this.hotkeys = hotkeys;
    this.miniPlayer = miniPlayer;
    this.lastfm = lastfm;
    this.zoom = zoom;
    this.downloads = downloads;
    this.player = player;
    this.settingsWindow = settingsWindow;
    this.logger = logger;
    this.dataDir = dataDir;
    this.version = version;
    this.tray = null;
  }

  get config() {
    return this.settings.get('ui') ?? {};
  }

  start() {
    if (!this.config.trayIcon) {
      this.logger.info('Tray icon disabled in settings');
      return;
    }
    try {
      this.tray = new electron.Tray(this.#icon());
      this.tray.setToolTip('itirpc — модификация Яндекс.Музыки');
      this.#rebuildMenu();
      // The checkmarks must follow settings changed from anywhere, including
      // the config file being edited by hand.
      this.settings.onChange(() => this.#rebuildMenu());
      electron.app.on('will-quit', () => this.dispose());
      this.logger.info('Tray icon created');
    } catch (error) {
      this.logger.warn('Could not create tray icon:', error.message);
    }
  }

  /** Reuses the client's own icon so the mod ships no binary assets. */
  #icon() {
    const candidates = [
      path.join(process.resourcesPath, 'assets', 'icon.ico'),
      path.join(process.resourcesPath, 'assets', 'icons', 'icon_32x32.png'),
    ];
    for (const candidate of candidates) {
      try {
        const image = electron.nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) return image;
      } catch {
        // Try the next candidate.
      }
    }
    return electron.nativeImage.createEmpty();
  }

  /** Rebuilds the menu after an action that changes a checkmark or label. */
  #applyZoom(action) {
    action();
    this.#rebuildMenu();
  }

  /** Saves the currently streamed track and reports the outcome in the tray. */
  #downloadCurrentTrack() {
    const state = this.player?.state;
    if (!this.downloads) return;
    if (!state?.streamUrl) {
      this.logger.warn('Скачивание недоступно: ссылка на поток ещё не получена');
      return;
    }

    const track = { title: state.title, artist: state.artist, album: state.album };
    this.downloads
      .download(track, state.streamUrl)
      .then((result) => {
        if (result.ok) {
          this.tray?.displayBalloon?.({
            title: 'itirpc',
            content: `Сохранено: ${path.basename(result.path)}`,
          });
        } else {
          this.logger.warn('Скачивание не удалось:', result.error);
        }
        this.#rebuildMenu();
      })
      .catch((error) => this.logger.error('Ошибка скачивания:', error));
    this.#rebuildMenu();
  }

  #lastFmLabel() {
    const status = this.lastfm?.status;
    if (!status) return 'Last.fm: модуль недоступен';
    if (!status.configured) return 'Last.fm: не заданы apiKey/sharedSecret';
    if (!status.authenticated) return 'Last.fm: не выполнен вход';
    return `Last.fm: ${status.username ?? 'пользователь'}`;
  }

  #handleLastFm() {
    if (!this.lastfm) return;
    if (this.lastfm.status.authenticated) {
      this.lastfm.signOut();
      this.#rebuildMenu();
      return;
    }
    this.lastfm
      .authorize()
      .then((result) => {
        if (!result.ok) this.logger.warn('Last.fm authorization failed:', result.error);
        this.#rebuildMenu();
      })
      .catch((error) => this.logger.error('Last.fm authorization error:', error));
  }

  #rebuildMenu() {
    if (!this.tray || this.tray.isDestroyed()) return;

    const discord = this.settings.get('discord') ?? {};
    const hotkeysConfig = this.settings.get('hotkeys') ?? {};
    const miniConfig = this.settings.get('miniplayer') ?? {};
    const lastfmConfig = this.settings.get('lastfm') ?? {};
    const uiConfig = this.settings.get('ui') ?? {};
    const downloadsConfig = this.settings.get('downloads') ?? {};

    const menu = electron.Menu.buildFromTemplate([
      {
        label: `itirpc ${this.version}`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Настройки itirpc…',
        click: () => this.settingsWindow?.show(),
      },
      { type: 'separator' },
      {
        label: 'Мини-плеер',
        type: 'checkbox',
        checked: Boolean(miniConfig.enabled) && Boolean(this.miniPlayer?.window?.isVisible?.()),
        click: () => this.miniPlayer?.toggle(),
      },
      {
        label: 'Discord Rich Presence',
        type: 'checkbox',
        checked: Boolean(discord.enabled),
        click: (item) => {
          this.settings.set('discord.enabled', item.checked);
          this.logger.info('Discord RPC', item.checked ? 'enabled' : 'disabled');
        },
      },
      {
        label: 'Глобальные хоткеи',
        type: 'checkbox',
        checked: Boolean(hotkeysConfig.enabled),
        click: (item) => {
          this.settings.set('hotkeys.enabled', item.checked);
        },
      },
      {
        label: 'Закрепить мини-плеер поверх окон',
        type: 'checkbox',
        checked: Boolean(miniConfig.alwaysOnTop),
        click: (item) => {
          this.settings.set('miniplayer.alwaysOnTop', item.checked);
          if (this.miniPlayer?.window && !this.miniPlayer.window.isDestroyed()) {
            this.miniPlayer.window.setAlwaysOnTop(item.checked);
          }
        },
      },
      { type: 'separator' },
      {
        label: this.#lastFmLabel(),
        enabled: Boolean(this.lastfm?.status.authenticated),
      },
      {
        label: this.lastfm?.status.authenticated
          ? 'Выйти из Last.fm'
          : 'Авторизоваться в Last.fm',
        click: () => this.#handleLastFm(),
      },
      {
        label: 'Скробблинг Last.fm',
        type: 'checkbox',
        checked: Boolean(lastfmConfig.enabled),
        click: (item) => this.settings.set('lastfm.enabled', item.checked),
      },
      { type: 'separator' },
      {
        label: this.zoom ? `Масштаб: ${Math.round(this.zoom.factor * 100)}%` : 'Масштаб',
        submenu: [
          {
            label: 'Увеличить   Ctrl+=',
            enabled: Boolean(this.zoom) && !this.zoom.atMaximum,
            click: () => this.#applyZoom(() => this.zoom.zoomIn()),
          },
          {
            label: 'Уменьшить   Ctrl+-',
            enabled: Boolean(this.zoom) && !this.zoom.atMinimum,
            click: () => this.#applyZoom(() => this.zoom.zoomOut()),
          },
          {
            label: 'Сбросить 100%   Ctrl+0',
            enabled: Boolean(this.zoom) && this.zoom.factor !== 1,
            click: () => this.#applyZoom(() => this.zoom.reset()),
          },
          { type: 'separator' },
          { label: 'Показывать кодек в мини-плеере', type: 'checkbox',
            checked: Boolean(uiConfig.showCodec),
            click: (item) => this.settings.set('ui.showCodec', item.checked) },
        ],
      },
      { type: 'separator' },
      {
        // Off by default: the client's stream is encrypted, so a saved file
        // would be unreadable. See the downloads section in settings.js.
        label: downloadsConfig.enabled
          ? 'Скачать текущий трек'
          : 'Скачивание отключено (поток зашифрован)',
        enabled:
          Boolean(downloadsConfig.enabled) &&
          Boolean(this.downloads && this.player?.state?.streamUrl) &&
          !this.downloads?.active,
        click: () => this.#downloadCurrentTrack(),
      },
      {
        label: 'Открыть папку загрузок',
        click: () => electron.shell.openPath(this.downloads?.directory ?? this.dataDir),
      },
      { type: 'separator' },
      {
        label: 'Открыть config.json',
        click: () => electron.shell.openPath(path.join(this.dataDir, 'config.json')),
      },
      {
        label: 'Открыть папку логов',
        click: () => electron.shell.openPath(path.join(this.dataDir, 'logs')),
      },
      { type: 'separator' },
      { label: 'Выход', click: () => electron.app.quit() },
    ]);

    this.tray.setContextMenu(menu);
  }

  dispose() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { ModTray };

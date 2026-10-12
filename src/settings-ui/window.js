'use strict';

/**
 * Settings window.
 *
 * A separate BrowserWindow hosting our own page, for the same reason the mini
 * player is one: injecting a form into the client's minified Next.js renderer
 * would be fragile and would reach into code we do not own.
 *
 * Two rules keep the bridge safe:
 *  - only the window we created may talk to it (sender identity is checked);
 *  - writes are refused unless the path appears in the settings schema.
 */

const path = require('node:path');
const electron = require('electron');
const { CHANNELS, ACTIONS } = require('./channels');
const { SECTIONS, FIELD_TYPES, editablePaths } = require('./schema');

const WINDOW_TITLE = 'Настройки itirpc';

/** Field type lookup, so a write can be coerced to the right kind. */
const TYPE_BY_PATH = (() => {
  const map = new Map();
  for (const section of SECTIONS) {
    for (const field of section.fields) {
      if (field.path) map.set(field.path, field.type);
    }
  }
  return map;
})();

const WRITABLE_PATHS = new Set(editablePaths());

class SettingsWindow {
  constructor({ settings, presence, scrobbler, hotkeys, miniPlayer, zoom, downloads, player, dataDir, version, logger }) {
    this.settings = settings;
    this.presence = presence;
    this.scrobbler = scrobbler;
    this.hotkeys = hotkeys;
    this.miniPlayer = miniPlayer;
    this.zoom = zoom;
    this.downloads = downloads;
    this.player = player;
    this.dataDir = dataDir;
    this.version = version;
    this.logger = logger;
    this.window = null;
    this.bound = false;
    this.unsubscribe = null;
  }

  toggle() {
    if (this.window && this.window.isVisible()) this.hide();
    else this.show();
  }

  show() {
    if (!electron.app.isReady()) {
      this.logger.warn('Settings requested before the app was ready');
      return;
    }
    if (!this.window || this.window.isDestroyed()) this.#create();
    this.window.show();
    this.window.focus();
    this.#pushStatus();
  }

  hide() {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  dispose() {
    this.unsubscribe?.();
    if (this.window && !this.window.isDestroyed()) {
      this.window.removeAllListeners();
      this.window.destroy();
    }
    this.window = null;
  }

  #create() {
    const window = new electron.BrowserWindow({
      width: 880,
      height: 660,
      minWidth: 620,
      minHeight: 460,
      title: WINDOW_TITLE,
      show: false,
      backgroundColor: '#0f1115',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    window.loadFile(path.join(__dirname, 'index.html'));
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show();
    });
    window.on('closed', () => {
      this.window = null;
    });

    this.window = window;
    this.#bindIpc();

    // Keep the panel in step with changes made anywhere else (tray, hotkeys,
    // or the config file being edited by hand).
    this.unsubscribe = this.settings.onChange(() => this.#pushStatus());

    this.logger.info('Settings window created');
  }

  #bindIpc() {
    if (this.bound) return;
    this.bound = true;

    electron.ipcMain.handle(CHANNELS.GET_ALL, (event) => {
      if (!this.#isFromWindow(event)) return null;
      return this.#snapshot();
    });

    electron.ipcMain.handle(CHANNELS.SET, (event, payload) => {
      if (!this.#isFromWindow(event)) return { ok: false, error: 'недоверенный отправитель' };
      return this.#applySetting(payload);
    });

    electron.ipcMain.handle(CHANNELS.ACTION, (event, payload) => {
      if (!this.#isFromWindow(event)) return { ok: false, error: 'недоверенный отправитель' };
      return this.#runAction(payload);
    });

    electron.ipcMain.on(CHANNELS.READY, (event) => {
      if (!this.#isFromWindow(event)) return;
      this.#pushStatus();
    });
  }

  /** Only our own window may drive the settings bridge. */
  #isFromWindow(event) {
    return Boolean(this.window) && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  // --- reading -------------------------------------------------------------

  #snapshot() {
    return {
      version: this.version,
      settings: this.settings.data,
      status: this.#status(),
      problems: this.#problems(),
      hotkeyStates: this.#hotkeyStates(),
    };
  }

  #status() {
    const discord = this.settings.get('discord') ?? {};
    return {
      discord: {
        enabled: Boolean(discord.enabled),
        hasClientId: Boolean(discord.clientId),
        connected: Boolean(this.presence?.ipc?.connected),
      },
      lastfm: this.scrobbler?.status ?? null,
      zoom: this.zoom?.factor ?? 1,
      miniPlayerOpen: Boolean(this.miniPlayer?.window?.isVisible?.()),
      cacheDirectory: this.#cacheDirectory(),
      downloadsActive: Boolean(this.downloads?.active),
    };
  }

  #cacheDirectory() {
    try {
      return electron.app.getPath('userData');
    } catch {
      return this.dataDir;
    }
  }

  /**
   * Surfaces conditions the user should know about rather than leaving them to
   * be discovered from the log.
   */
  #problems() {
    const problems = [];
    const discord = this.settings.get('discord') ?? {};
    const lastfm = this.settings.get('lastfm') ?? {};
    const downloads = this.settings.get('downloads') ?? {};

    if (discord.enabled && !discord.clientId) {
      problems.push(
        'Discord Rich Presence включён, но Application ID не задан — статус показываться не будет.',
      );
    }
    if (lastfm.enabled && (!lastfm.apiKey || !lastfm.sharedSecret)) {
      problems.push('Скробблинг Last.fm включён, но API key или shared secret не заданы.');
    }
    if (lastfm.enabled && !lastfm.sessionKey) {
      problems.push('Last.fm: вход не выполнен, треки не отправляются.');
    }
    if (downloads.enabled) {
      problems.push(
        'Скачивание включено, но поток клиента зашифрован: сохранённые файлы не открываются. ' +
          'Функция оставлена выключенной осознанно.',
      );
    }

    const takenHotkeys = Object.entries(this.#hotkeyStates()).filter(([, state]) => state === false);
    if (takenHotkeys.length) {
      problems.push(
        `Заняты другой программой: ${takenHotkeys.map(([key]) => key).join(', ')}. ` +
          'Выберите другие комбинации.',
      );
    }

    return problems;
  }

  /** action key -> true (registered) | false (taken) | null (disabled). */
  #hotkeyStates() {
    const out = {};
    if (!this.hotkeys) return out;
    for (const entry of this.hotkeys.describe()) {
      if (entry.accelerator === 'none' || !entry.accelerator) out[entry.key] = null;
      else out[entry.key] = entry.active;
    }
    return out;
  }

  // --- writing -------------------------------------------------------------

  #applySetting(payload) {
    const { path: settingPath, value } = payload ?? {};

    if (typeof settingPath !== 'string' || !WRITABLE_PATHS.has(settingPath)) {
      this.logger.warn('Settings window tried to write an unknown path:', settingPath);
      return { ok: false, error: `путь "${settingPath}" не разрешён` };
    }

    const coerced = this.#coerce(settingPath, value);
    if (!coerced.ok) return coerced;

    this.settings.set(settingPath, coerced.value);
    this.logger.info(`Настройка изменена: ${settingPath} = ${JSON.stringify(coerced.value)}`);
    this.#pushStatus();
    return { ok: true, value: coerced.value };
  }

  /** Keeps the stored types honest regardless of what the form sends. */
  #coerce(settingPath, value) {
    const type = TYPE_BY_PATH.get(settingPath);

    if (type === FIELD_TYPES.BOOLEAN) return { ok: true, value: Boolean(value) };

    if (type === FIELD_TYPES.NUMBER) {
      const number = Number(value);
      if (!Number.isFinite(number)) return { ok: false, error: 'ожидалось число' };
      return { ok: true, value: number };
    }

    if (type === FIELD_TYPES.HOTKEY) {
      if (typeof value !== 'string' || value.length > 64) {
        return { ok: false, error: 'некорректная комбинация' };
      }
      return { ok: true, value };
    }

    if (type === FIELD_TYPES.SELECT) {
      const field = SECTIONS.flatMap((section) => section.fields).find((f) => f.path === settingPath);
      const allowed = (field?.options ?? []).map((option) => option.value);
      if (allowed.length && !allowed.some((option) => option === value)) {
        return { ok: false, error: 'значение не из списка' };
      }
      return { ok: true, value };
    }

    if (typeof value !== 'string') return { ok: false, error: 'ожидалась строка' };
    return { ok: true, value: value.slice(0, 512) };
  }

  // --- actions -------------------------------------------------------------

  async #runAction(payload) {
    const { name, value } = payload ?? {};
    if (!ACTIONS.includes(name)) {
      this.logger.warn('Settings window requested an unknown action:', name);
      return { ok: false, error: `действие "${name}" не разрешено` };
    }

    try {
      switch (name) {
        case 'lastfm-authorize': {
          const result = await this.scrobbler?.authorize();
          this.#pushStatus();
          return result ?? { ok: false, error: 'модуль Last.fm недоступен' };
        }
        case 'lastfm-signout':
          this.scrobbler?.signOut();
          this.#pushStatus();
          return { ok: true };
        case 'miniplayer-open':
          this.miniPlayer?.show();
          this.#pushStatus();
          return { ok: true };
        case 'open-config':
          return this.#openPath(path.join(this.dataDir, 'config.json'));
        case 'open-logs':
          return this.#openPath(path.join(this.dataDir, 'logs'));
        case 'open-downloads':
          return this.#openPath(this.downloads?.directory ?? this.dataDir);
        case 'open-mod-folder':
          return this.#openPath(this.dataDir);
        case 'zoom-reset':
          this.zoom?.reset();
          this.#pushStatus();
          return { ok: true };
        case 'pick-directory':
          return this.#pickDirectory(value);
        default:
          return { ok: false, error: 'не реализовано' };
      }
    } catch (error) {
      this.logger.error(`Действие "${name}" не удалось:`, error);
      return { ok: false, error: error.message };
    }
  }

  async #openPath(target) {
    const error = await electron.shell.openPath(target);
    if (error) {
      this.logger.warn('Не удалось открыть путь:', target, error);
      return { ok: false, error };
    }
    return { ok: true };
  }

  async #pickDirectory(current) {
    const result = await electron.dialog.showOpenDialog(this.window, {
      title: 'Выберите папку',
      defaultPath: typeof current === 'string' && current ? current : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  }

  #pushStatus() {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(CHANNELS.STATUS, {
      status: this.#status(),
      problems: this.#problems(),
      hotkeyStates: this.#hotkeyStates(),
    });
  }
}

module.exports = { SettingsWindow, WRITABLE_PATHS };

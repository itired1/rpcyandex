'use strict';

/**
 * Global media hotkeys.
 *
 * Registered through Electron's `globalShortcut`, so they work while the client
 * is in the background. Playback control goes through the client's own
 * `desktop:player:action` channel rather than simulated key presses, which
 * keeps behaviour identical to the tray menu.
 *
 * Registration can fail when another application already owns a combination;
 * that is reported per shortcut instead of aborting the rest.
 */

const electron = require('electron');
const { ACTIONS, MOD_ACTIONS, isDisabled, pickAccelerators } = require('./hotkey-definitions');

class HotkeyManager {
  constructor({ settings, player, logger, miniPlayer, onChange }) {
    this.settings = settings;
    this.player = player;
    this.logger = logger;
    this.miniPlayer = miniPlayer;
    this.onChange = onChange;
    this.registered = new Map();
    this.enabled = false;
    /** Signature of the last registered accelerator set. */
    this.signature = null;
  }

  get config() {
    return this.settings.get('hotkeys') ?? {};
  }

  start() {
    this.reload();
    // Hotkey edits in config.json apply immediately, matching the rest of the
    // mod's settings behaviour.
    this.unsubscribe = this.settings.onChange(() => this.reload());
    electron.app.on('will-quit', () => this.stop());
  }

  stop() {
    this.unsubscribe?.();
    this.unregisterAll();
  }

  unregisterAll() {
    for (const accelerator of this.registered.keys()) {
      try {
        electron.globalShortcut.unregister(accelerator);
      } catch {
        // Already gone.
      }
    }
    this.registered.clear();
  }

  /** Rebuilds the registration set from the current settings. */
  reload() {
    const config = this.config;

    // Settings can fire for keys this manager does not care about (window
    // geometry, Discord toggles). Re-registering global shortcuts is expensive
    // and briefly releases them, so only act when the relevant set changed.
    const signature = JSON.stringify({ enabled: config.enabled, ...pickAccelerators(config) });
    if (signature === this.signature && this.registered.size > 0) return;
    this.signature = signature;

    this.unregisterAll();
    this.enabled = Boolean(config.enabled);

    if (!this.enabled) {
      this.logger.info('Global hotkeys disabled in settings');
      this.onChange?.();
      return;
    }

    const allActions = {
      ...ACTIONS,
      ...Object.fromEntries(
        Object.entries(MOD_ACTIONS).map(([key, handler]) => [key, () => handler(this)]),
      ),
    };

    for (const [key, action] of Object.entries(allActions)) {
      const accelerator = config[key];
      if (isDisabled(accelerator)) continue;

      const handler = () => {
        try {
          const result = action(this.player);
          // Volume helpers are async; swallow rejections so a failure to reach
          // the renderer cannot surface as an unhandled rejection.
          if (result && typeof result.catch === 'function') result.catch(() => {});
          this.logger.debug('Hotkey fired:', key, accelerator);
        } catch (error) {
          this.logger.warn('Hotkey handler failed:', key, error.message);
        }
      };

      let ok = false;
      let failure = null;
      try {
        ok = electron.globalShortcut.register(accelerator, handler);
      } catch (error) {
        // Thrown (rather than returning false) when the app is not ready yet or
        // the accelerator string is malformed — both need distinct reporting.
        failure = error.message;
      }

      if (ok) {
        this.registered.set(accelerator, key);
      } else if (failure) {
        this.logger.warn(`Hotkey "${accelerator}" (${key}) could not be registered: ${failure}`);
      } else {
        this.logger.warn(
          `Hotkey "${accelerator}" (${key}) is already taken by another application — skipped`,
        );
      }
    }

    const summary = [...this.registered.entries()].map(([acc, key]) => `${key}=${acc}`).join(', ');
    this.logger.info(`Global hotkeys active: ${summary || 'none'}`);
    this.onChange?.();
  }

  /** Snapshot for menus and status output. */
  describe() {
    return [...Object.keys(ACTIONS), ...Object.keys(MOD_ACTIONS)].map((key) => ({
      key,
      accelerator: this.config[key],
      active: [...this.registered.values()].includes(key),
    }));
  }
}

module.exports = { HotkeyManager, ACTIONS, MOD_ACTIONS, isDisabled, pickAccelerators };
'use strict';

/**
 * Hotkey definitions and pure helpers.
 *
 * Kept free of any Electron import so the mapping and the change detection can
 * be unit tested outside the client. `hotkeys.js` owns the actual registration.
 */

/** Setting key -> PlayerMonitor action. */
const ACTIONS = {
  playPause: (player) => player.togglePlay(),
  next: (player) => player.next(),
  previous: (player) => player.previous(),
  volumeUp: (player) => player.adjustVolume(0.05),
  volumeDown: (player) => player.adjustVolume(-0.05),
};

/** Actions handled by the mod itself; they receive the manager as context. */
const MOD_ACTIONS = {
  miniPlayer: (context) => context.miniPlayer?.toggle(),
  zoomIn: (context) => context.zoom?.zoomIn(),
  zoomOut: (context) => context.zoom?.zoomOut(),
  zoomReset: (context) => context.zoom?.reset(),
};

/** Every configurable shortcut key. */
const HOTKEY_KEYS = [...Object.keys(ACTIONS), ...Object.keys(MOD_ACTIONS)];

/** Values that mean "no shortcut": an empty string or an explicit "none". */
function isDisabled(accelerator) {
  return typeof accelerator !== 'string' || accelerator.trim() === '' || accelerator === 'none';
}

/** The subset of the hotkeys config that affects registration. */
function pickAccelerators(config = {}) {
  const out = {};
  for (const key of HOTKEY_KEYS) out[key] = config[key] ?? null;
  return out;
}

module.exports = { ACTIONS, MOD_ACTIONS, HOTKEY_KEYS, isDisabled, pickAccelerators };

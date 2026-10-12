'use strict';

/**
 * Application zoom.
 *
 * The client exposes no zoom UI of its own, so it is driven from the main
 * process through `webContents.setZoomFactor`. Zoom is stored as a plain factor
 * rather than Chrome's logarithmic level: users think in percentages, and it
 * keeps the persisted value readable in config.json.
 *
 * Every renderer that shows our UI is bound to the same controller, so the
 * client window and the mini player always agree. The factor is re-applied
 * after every navigation — zoom is per-origin state in Chromium, so a reload of
 * a frame would otherwise silently drop it.
 */

const MIN_FACTOR = 0.5;
const MAX_FACTOR = 3;
const STEP = 1.1;

/** Rounds to three decimals so repeated steps do not accumulate float noise. */
function clampFactor(value) {
  const clamped = Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, value));
  return Math.round(clamped * 1000) / 1000;
}

class ZoomController {
  constructor({ settings, logger }) {
    this.settings = settings;
    this.logger = logger;
    /** Every renderer that must render at the chosen factor. */
    this.targets = new Set();
    /** Per-renderer listener removers, so detaching one leaves the rest alone. */
    this.disposers = new Map();
    this.unsubscribe = null;
  }

  get factor() {
    const stored = Number(this.settings.get('ui.zoom'));
    return Number.isFinite(stored) && stored > 0 ? clampFactor(stored) : 1;
  }

  /** Binds a renderer and applies the saved zoom to it. */
  attach(webContents) {
    if (!webContents || this.targets.has(webContents)) return;

    this.targets.add(webContents);
    const apply = () => this.#applyTo(webContents);
    webContents.on('did-finish-load', apply);
    webContents.on('did-navigate', apply);
    this.disposers.set(webContents, [
      () => webContents.removeListener('did-finish-load', apply),
      () => webContents.removeListener('did-navigate', apply),
    ]);

    apply();
  }

  /** Unbinds one renderer; every other binding keeps working. */
  detach(webContents) {
    if (!webContents || !this.targets.has(webContents)) return;
    this.targets.delete(webContents);
    for (const dispose of this.disposers.get(webContents) ?? []) dispose();
    this.disposers.delete(webContents);
  }

  /**
   * Unbinds everything and stops following the setting.
   *
   * Also prunes renderers that were destroyed without an explicit detach, which
   * happens when the client replaces its window on update.
   */
  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const webContents of [...this.targets]) this.detach(webContents);
  }

  /**
   * Pushes the stored factor into every bound renderer.
   *
   * @returns {number} how many renderers actually accepted it.
   */
  apply() {
    let applied = 0;
    for (const webContents of [...this.targets]) {
      if (this.#applyTo(webContents)) applied += 1;
      else this.detach(webContents);
    }
    return applied;
  }

  #applyTo(webContents) {
    if (!webContents || webContents.isDestroyed()) return false;
    try {
      webContents.setZoomFactor(this.factor);
      this.logger.debug('Zoom applied:', this.factor);
      return true;
    } catch (error) {
      this.logger.warn('Could not apply zoom:', error.message);
      return false;
    }
  }

  /** @returns {number} the factor that was actually applied. */
  set(nextFactor) {
    const factor = clampFactor(nextFactor);
    // set() writes through to config.json, which the settings watcher turns
    // into a no-op reload because the value is unchanged.
    this.settings.set('ui.zoom', factor);
    this.apply();
    this.logger.info(`Масштаб: ${Math.round(factor * 100)}%`);
    return factor;
  }

  zoomIn() {
    return this.set(this.factor * STEP);
  }

  zoomOut() {
    return this.set(this.factor / STEP);
  }

  reset() {
    return this.set(1);
  }

  get atMinimum() {
    return this.factor <= MIN_FACTOR;
  }

  get atMaximum() {
    return this.factor >= MAX_FACTOR;
  }

  /**
   * Follows `ui.zoom` written from anywhere — the settings slider, the tray, a
   * hand-edited config.json. Without this the slider only took effect after the
   * next keyboard shortcut happened to call set().
   */
  watch() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.settings.onChange(() => this.apply());
  }
}

module.exports = {
  ZoomController,
  MIN_FACTOR,
  MAX_FACTOR,
  STEP,
  clampFactor,
};

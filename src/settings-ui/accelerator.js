'use strict';

/**
 * Converts a keyboard event into an Electron accelerator string.
 *
 * Written as a plain script that works both in the browser (attached to
 * `window.itirpcAccelerator`) and in Node (`module.exports`), so the mapping can
 * be unit tested without launching the settings window.
 *
 * Electron's accelerator grammar is specific: modifiers are `Control`, `Alt`,
 * `Shift`, `Super`; arrow keys are `Up`/`Down`/`Left`/`Right`; letters are
 * uppercase; function keys are `F1`…`F24`. An unrecognised key yields `null` so
 * the caller can ignore the press instead of storing something that will never
 * register.
 */

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
]);

/** Keys whose `event.key` differs from the accelerator name. */
const NAMED_KEYS = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Escape: 'Escape',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  '+': 'Plus',
  '-': 'Minus',
  '=': '=',
  ',': ',',
  '.': '.',
  '/': '/',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '`': '`',
};/** Punctuation that is only reachable with Shift, so Shift should be implied. */
const SHIFTED_SYMBOLS = new Set(['+', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '{', '}', '|', ':', '"', '<', '>', '?', '~']);

/** Maps a shifted symbol back to the key the user physically pressed. */
const SHIFT_SYMBOL_BASE = {
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: 'Minus',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
};

/** Numpad keys use Electron's own names, not the DOM `code` values. */
const NUMPAD_KEYS = {
  Numpad0: 'num0',
  Numpad1: 'num1',
  Numpad2: 'num2',
  Numpad3: 'num3',
  Numpad4: 'num4',
  Numpad5: 'num5',
  Numpad6: 'num6',
  Numpad7: 'num7',
  Numpad8: 'num8',
  Numpad9: 'num9',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
};

const MEDIA_KEYS = {
  MediaPlayPause: 'MediaPlayPause',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
};

/** @returns {string|null} accelerator, or null when the key is not usable. */
function toAccelerator(event) {
  if (!event) return null;
  if (MODIFIER_CODES.has(event.code)) return null; // a lone modifier is not a shortcut
  if (event.repeat) return null;

  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey && !SHIFTED_SYMBOLS.has(event.key)) parts.push('Shift');
  if (event.metaKey) parts.push('Super');

  let key = null;

  if (MEDIA_KEYS[event.key]) {
    key = MEDIA_KEYS[event.key];
  } else if (NUMPAD_KEYS[event.code]) {
    key = NUMPAD_KEYS[event.code];
  } else if (SHIFTED_SYMBOLS.has(event.key)) {
    // A shifted symbol already implies Shift; store the base key.
    key = SHIFT_SYMBOL_BASE[event.key] ?? null;
  } else if (NAMED_KEYS[event.key]) {
    key = NAMED_KEYS[event.key];
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) {
    key = event.key;
  } else if (/^[a-zA-Z]$/.test(event.key)) {
    key = event.key.toUpperCase();
  } else if (/^[0-9]$/.test(event.key)) {
    key = event.key;
  }

  if (!key) return null;

  // A shortcut needs a modifier; dedicated media keys and function keys do not.
  const isStandalone = Boolean(MEDIA_KEYS[event.key]) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (parts.length === 0 && !isStandalone) return null;

  return [...parts, key].join('+');
}

/** Human-readable form for display; the stored value stays canonical. */
function describeAccelerator(accelerator) {
  if (!accelerator) return 'не задано';
  return String(accelerator)
    .replace(/Control/g, 'Ctrl')
    .replace(/Super/g, 'Win')
    .replace(/\+/g, ' + ');
}

module.exports = {
  toAccelerator,
  describeAccelerator,
  MODIFIER_CODES,
  NAMED_KEYS,
  SHIFTED_SYMBOLS,
  NUMPAD_KEYS,
  MEDIA_KEYS,
};

// Also expose to the settings window, which loads this file with a <script> tag.
if (typeof window !== 'undefined') {
  window.itirpcAccelerator = { toAccelerator, describeAccelerator };
}

'use strict';

/**
 * Boot trace — the first thing the mod does, before any other require.
 *
 * When a patched client refuses to start there is usually no output at all: a
 * failed asar integrity validation or an early `app.quit()` kills the process
 * before any logger is initialised. Writing a marker next to the executable is
 * the only way to tell "the mod never loaded" apart from "the mod loaded and
 * something later failed", which is the difference between a packaging bug and
 * a patch bug.
 *
 * Failures are swallowed: diagnosing startup must never cause it.
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'itirpc-boot.log';

function candidatePaths() {
  const out = [];
  try {
    out.push(path.join(process.resourcesPath, MARKER));
  } catch {
    // resourcesPath is always defined in Electron, but stay defensive.
  }
  try {
    out.push(path.join(path.dirname(process.execPath), MARKER));
  } catch {
    // execPath is always defined; kept for symmetry.
  }
  try {
    const appData = process.env.APPDATA ?? process.env.HOME;
    if (appData) out.push(path.join(appData, 'YandexMusic', MARKER));
  } catch {
    // Environment may be stripped in unusual launches.
  }
  return out;
}

/** Appends a timestamped line to every writable trace location. */
function trace(message) {
  const detail =
    typeof message === 'object' && message !== null ? JSON.stringify(message) : String(message);
  const line = `[${new Date().toISOString()}] ${detail}\n`;
  for (const target of candidatePaths()) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, line);
    } catch {
      // Read-only install directory, missing drive, sandbox — all ignorable.
    }
  }
}

/** Records an unrecoverable startup failure with its stack, then rethrows nothing. */
function traceError(scope, error) {
  trace(`${scope} FAILED: ${error?.name ?? 'Error'}: ${error?.message ?? error}`);
  if (error?.stack) trace(error.stack.split('\n').slice(0, 6).join(' | '));
}

module.exports = { trace, traceError, MARKER, candidatePaths };

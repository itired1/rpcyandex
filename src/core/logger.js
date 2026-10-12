'use strict';

/**
 * Minimal file + console logger.
 *
 * The client's own electron-log is available, but using our own sink keeps mod
 * output in one predictable place and guarantees nothing is lost when the
 * client's log level is tightened.
 */

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let logFile = null;
let logDir = null;
let level = LEVELS.info;
let maxBytes = 2 * 1024 * 1024;

function configure(options) {
  if (options.dir) {
    logDir = options.dir;
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'itirpc.log');
  }
  if (options.level && options.level in LEVELS) level = LEVELS[options.level];
  if (typeof options.maxBytes === 'number') maxBytes = options.maxBytes;
}

/** Keeps the log from growing without bound across long sessions. */
function rotateIfNeeded() {
  if (!logFile) return;
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < maxBytes) return;
    const old = path.join(logDir, 'itirpc.old.log');
    fs.rmSync(old, { force: true });
    fs.renameSync(logFile, old);
  } catch {
    // A missing log file is the normal first-run case.
  }
}

function write(lvl, scope, args) {
  if (LEVELS[lvl] > level) return;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] [${lvl.toUpperCase()}] [${scope}] ${args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ')}\n`;

  if (lvl === 'error') process.stderr.write(line);
  else process.stdout.write(line);

  if (!logFile) return;
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFile, line);
  } catch {
    // Logging must never take the client down.
  }
}

function create(scope) {
  return {
    error: (...args) => write('error', scope, args),
    warn: (...args) => write('warn', scope, args),
    info: (...args) => write('info', scope, args),
    debug: (...args) => write('debug', scope, args),
  };
}

module.exports = {
  configure,
  create,
  get file() {
    return logFile;
  },
  LEVELS,
};

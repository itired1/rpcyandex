'use strict';

/**
 * Channel names shared between the mini player main-process module and its
 * preload script.
 *
 * `preload.js` cannot require this file: a sandboxed preload only gets a small
 * allowlist of modules, so it inlines the same literals. The test suite asserts
 * that both copies stay identical.
 */

const CHANNELS = {
  STATE: 'itirpc:mini:state',
  TRACK: 'itirpc:mini:track',
  COMMAND: 'itirpc:mini:command',
  READY: 'itirpc:mini:ready',
  RESIZE: 'itirpc:mini:resize',
};

module.exports = { CHANNELS };

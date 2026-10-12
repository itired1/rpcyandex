'use strict';

/**
 * Channel names for the settings window.
 *
 * `preload.js` cannot require this file (a sandboxed preload only gets a small
 * module allowlist), so it inlines the same literals. The test suite asserts the
 * two copies cannot drift apart.
 */

const CHANNELS = {
  /** Renderer -> main, expects a reply. */
  GET_ALL: 'itirpc:settings:get-all',
  SET: 'itirpc:settings:set',
  ACTION: 'itirpc:settings:action',
  /** Main -> renderer. */
  STATUS: 'itirpc:settings:status',
  READY: 'itirpc:settings:ready',
};

/** Actions the renderer may request; anything else is refused. */
const ACTIONS = [
  'lastfm-authorize',
  'lastfm-signout',
  'miniplayer-open',
  'open-config',
  'open-logs',
  'open-downloads',
  'open-mod-folder',
  'zoom-reset',
  'pick-directory',
];

module.exports = { CHANNELS, ACTIONS };

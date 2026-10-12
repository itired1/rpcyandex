'use strict';

/**
 * Bridge for the itirpc settings window.
 *
 * The window renders our own page, so it gets a purpose-built, allow-listed API
 * rather than the client's `musicDesktop` bridge. Channel names are inlined
 * because a sandboxed preload cannot require local modules; `channels.js` holds
 * the same literals and a test keeps them in sync.
 */

const electron = require('electron');

const CHANNELS = {
  GET_ALL: 'itirpc:settings:get-all',
  SET: 'itirpc:settings:set',
  ACTION: 'itirpc:settings:action',
  STATUS: 'itirpc:settings:status',
  READY: 'itirpc:settings:ready',
};

electron.contextBridge.exposeInMainWorld('itirpcSettings', {
  channels: CHANNELS,

  /** Full settings snapshot plus the current status of every subsystem. */
  getAll() {
    return electron.ipcRenderer.invoke(CHANNELS.GET_ALL);
  },

  /** Writes one setting; resolves to `{ ok, error? }`. */
  set(path, value) {
    return electron.ipcRenderer.invoke(CHANNELS.SET, { path, value });
  },

  /** Runs one of the allow-listed actions from `channels.js`. */
  action(name) {
    return electron.ipcRenderer.invoke(CHANNELS.ACTION, { name });
  },

  /** Subscribes to status pushes; returns an unsubscribe function. */
  onStatus(listener) {
    const wrapped = (_event, payload) => listener(payload);
    electron.ipcRenderer.on(CHANNELS.STATUS, wrapped);
    return () => electron.ipcRenderer.removeListener(CHANNELS.STATUS, wrapped);
  },

  ready() {
    electron.ipcRenderer.send(CHANNELS.READY);
  },

  /** Asks the main process for a native directory picker. */
  pickDirectory(current) {
    return electron.ipcRenderer.invoke(CHANNELS.ACTION, { name: 'pick-directory', value: current });
  },
});

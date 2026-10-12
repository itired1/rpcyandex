'use strict';

/**
 * Bridge for the itirpc mini player window.
 *
 * The mini player is our own renderer, so it gets a purpose-built, minimal API
 * instead of the client's `musicDesktop` bridge. Everything is allow-listed:
 * the renderer can only report state changes and request playback commands.
 */

const electron = require('electron');

const CHANNELS = {
  STATE: 'itirpc:mini:state',
  TRACK: 'itirpc:mini:track',
  COMMAND: 'itirpc:mini:command',
  READY: 'itirpc:mini:ready',
  RESIZE: 'itirpc:mini:resize',
};

electron.contextBridge.exposeInMainWorld('itirpcMini', {
  channels: CHANNELS,

  /** Registers a listener and returns an unsubscribe function. */
  on(channel, listener) {
    if (channel !== CHANNELS.STATE && channel !== CHANNELS.TRACK) {
      throw new Error(`itirpcMini: channel "${channel}" is not subscribable`);
    }
    const wrapped = (_event, payload) => listener(payload);
    electron.ipcRenderer.on(channel, wrapped);
    return () => electron.ipcRenderer.removeListener(channel, wrapped);
  },

  /** Announces that the document is ready to receive state. */
  ready() {
    electron.ipcRenderer.send(CHANNELS.READY);
  },

  /** Asks the main process to resize the window to fit the layout mode. */
  requestSize(width, height) {
    electron.ipcRenderer.send(CHANNELS.RESIZE, { width, height });
  },

  control(command) {
    const allowed = [
      'toggle',
      'next',
      'previous',
      'volumeUp',
      'volumeDown',
      'seek',
      'togglePin',
      'hide',
    ];
    if (!allowed.includes(command?.action)) {
      throw new Error(`itirpcMini: unknown command "${command?.action}"`);
    }
    electron.ipcRenderer.send(CHANNELS.COMMAND, command);
  },
});

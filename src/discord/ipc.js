'use strict';

/**
 * Discord IPC transport, implemented directly against the local socket protocol.
 *
 * The mod ships inside the client's app.asar, which has no package manager and
 * no network access, so a `discord-rpc`/`@xhayper/discord-rpc` dependency is not
 * an option. The protocol is small and stable, and owning it also lets us fix
 * the well-known "presence disappears after a minute" behaviour properly:
 * we handle PING/PONG ourselves, reconnect on close, and re-assert the activity
 * on a heartbeat instead of relying on an unchanged-state short circuit.
 *
 * Wire format — every message is a little-endian header plus a JSON body:
 *
 *     [opcode: uint32][length: uint32][utf8 JSON payload]
 */

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const OPCODE = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
};

/**
 * Discord listens on `discord-ipc-{0..9}`. Windows uses named pipes; Linux and
 * macOS use unix sockets, and the Flatpak/Snap builds nest them one level
 * deeper. `DISCORD_IPC_PATH` overrides everything.
 */
function candidateSocketPaths() {
  const paths = [];
  if (process.env.DISCORD_IPC_PATH) paths.push(process.env.DISCORD_IPC_PATH);

  if (process.platform === 'win32') {
    for (let i = 0; i < 10; i += 1) {
      paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
      paths.push(`\\\\.\\pipe\\discord-ipc-${i}`);
    }
    return paths;
  }

  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  for (let i = 0; i < 10; i += 1) {
    paths.push(`${base}/discord-ipc-${i}`);
    paths.push(`${base}/app/com.discordapp.Discord/discord-ipc-${i}`);
    paths.push(`${base}/snap.discord/discord-ipc-${i}`);
  }
  return paths;
}

function encodeFrame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeUInt32LE(opcode, 0);
  frame.writeUInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

class DiscordIpc extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.clientId Discord application id.
   * @param {object} options.logger
   * @param {number} [options.connectTimeoutMs]
   */
  constructor({ clientId, logger, connectTimeoutMs = 5000 }) {
    super();
    this.clientId = clientId;
    this.logger = logger;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.closing = false;
  }

  /** Tries each candidate socket in turn until one accepts a handshake. */
  async connect() {
    this.closing = false;
    const paths = candidateSocketPaths();
    let firstError = null;

    for (const path of paths) {
      try {
        await this.#connectTo(path);
        return true;
      } catch (error) {
        // Discord is usually not on the first few indices; keep looking, but
        // remember why so a total failure can report something actionable.
        if (!firstError) firstError = { path, error };
      }
    }

    this.logger.debug(
      `Discord IPC socket not found (is Discord running?). First attempt: ${firstError?.path} — ${
        firstError?.error?.message ?? 'unknown error'
      }`,
    );
    return false;
  }

  #connectTo(path) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path });
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`timeout connecting to ${path}`));
      }, this.connectTimeoutMs);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };

      socket.once('error', fail);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('error', fail);

        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => this.#onData(chunk));
        socket.on('error', (error) => this.#onDisconnect(error));
        socket.on('close', () => this.#onDisconnect(new Error('socket closed')));

        this.#send(OPCODE.HANDSHAKE, { v: 1, client_id: this.clientId });
        this.logger.debug(`Discord IPC connected via ${path}`);
        resolve(true);
      });
    });
  }

  #onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (this.buffer.length < 8 + length) break;

      const body = this.buffer.subarray(8, 8 + length).toString('utf8');
      this.buffer = this.buffer.subarray(8 + length);

      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        this.logger.warn('Discord sent unparsable payload, ignoring');
      }
      if (payload) this.#dispatch(opcode, payload);
    }
  }

  #dispatch(opcode, payload) {
    switch (opcode) {
      case OPCODE.PING:
        this.#send(OPCODE.PONG, payload);
        break;
      case OPCODE.CLOSE:
        this.logger.warn('Discord closed the connection:', payload?.message ?? payload);
        this.#onDisconnect(new Error(payload?.message ?? 'closed by Discord'));
        break;
      case OPCODE.FRAME:
        if (payload.evt === 'READY') {
          this.connected = true;
          this.logger.info(
            'Discord RPC ready as',
            payload.data?.user?.username ?? payload.data?.user?.global_name ?? 'unknown user',
          );
          this.emit('ready', payload.data);
        } else if (payload.evt === 'ERROR') {
          this.logger.warn('Discord RPC error:', payload.data?.message ?? payload.data);
          this.emit('rpc-error', payload.data);
        } else {
          this.emit('frame', payload);
        }
        break;
      default:
        this.emit('frame', payload);
    }
  }

  #onDisconnect(error) {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    const wasConnected = this.connected;
    this.connected = false;
    if (this.closing) return;
    if (wasConnected || error) this.emit('disconnected', error);
  }

  #send(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(encodeFrame(opcode, payload));
      return true;
    } catch (error) {
      this.logger.warn('Failed to write to Discord IPC:', error.message);
      return false;
    }
  }

  /** Publishes an activity, or clears it when `activity` is null. */
  setActivity(activity, pid = process.pid) {
    if (!this.connected) return false;
    return this.#send(OPCODE.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: activity ? { pid, activity } : { pid, activity: null },
      nonce: crypto.randomUUID(),
    });
  }

  destroy() {
    this.closing = true;
    this.connected = false;
    if (this.socket) {
      try {
        this.#send(OPCODE.CLOSE, {});
      } catch {
        // Closing a broken socket is best effort.
      }
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.removeAllListeners();
  }
}

module.exports = { DiscordIpc, OPCODE, encodeFrame, candidateSocketPaths };

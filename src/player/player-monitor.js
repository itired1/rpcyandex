'use strict';

/**
 * Polls the renderer probe and turns raw snapshots into a stable player state.
 *
 * Two things are tracked that the vanilla IPC channel does not carry: track
 * metadata (from MediaMetadata) and playback progress (from the media element
 * or from the last setPositionState call extrapolated by wall-clock).
 */

const { EventEmitter } = require('node:events');
const { INSTALL_SOURCE, SNAPSHOT_SOURCE, CONTROL_SOURCE } = require('./probe');

const POLL_INTERVAL_MS = 1000;

/** IpcChannel.PLAYER_ACTION values accepted by the vanilla renderer. */
const PLAYER_ACTION = {
  PLAY: 'PLAY',
  PAUSE: 'PAUSE',
  MOVE_BACKWARD: 'MOVE_BACKWARD',
  MOVE_FORWARD: 'MOVE_FORWARD',
};

const PLAYER_ACTION_CHANNEL = 'desktop:player:action';

/** Picks the highest-resolution artwork URL MediaMetadata offers. */
function pickCover(artwork) {
  if (!Array.isArray(artwork) || artwork.length === 0) return null;
  const scored = artwork
    .filter((art) => art && typeof art.src === 'string' && art.src)
    .map((art) => {
      const match = /^(\d+)x(\d+)$/.exec(art.sizes ?? '');
      return { src: art.src, area: match ? Number(match[1]) * Number(match[2]) : 0 };
    })
    .sort((a, b) => b.area - a.area);
  return scored.length ? scored[0].src : null;
}

/**
 * Derives codec and bitrate from a stream URL.
 *
 * The client's player internals are minified and unreachable, but the stream URL
 * is observable. A real Yandex URL looks like:
 *
 *   https://strm-mar-135.strm.yandex.net/music-v2/crypt/ysign1=…/0/50334/…/aac192-mp4
 *     ?container=mp4&codec=mp4a.40.2&vsid=…#t=0
 *
 * Only explicit markers are trusted. The first version of this function scanned
 * for any 2-3 digit number and reported the server index from `strm-mar-135` as
 * a 135 kbps bitrate, while the real value (192) sits in the `aac192` token.
 */
const CODEC_NAMES = { aac: 'AAC', mp3: 'MP3', flac: 'FLAC', opus: 'Opus' };

/**
 * A codec token in a path or file name, optionally followed by its bitrate.
 * Covers every form seen in practice: `aac192`, `mp3_320`, `flac1411`, `aac`.
 * The codec name is what makes the number safe to interpret.
 */
const CODEC_TOKEN = /(?:^|[-_/.])(aac|mp3|flac|opus)[-_]?(\d{2,4})?(?=[-_.?/&#]|$)/i;

/** Media codec identifiers that appear in a `codec=` query parameter. */
const RFC_CODEC_NAMES = [
  { pattern: /mp4a|aac/i, name: 'AAC' },
  { pattern: /mp3|mpeg/i, name: 'MP3' },
  { pattern: /flac/i, name: 'FLAC' },
  { pattern: /opus/i, name: 'Opus' },
  { pattern: /alac/i, name: 'ALAC' },
  { pattern: /vorbis/i, name: 'Vorbis' },
];

/** Bitrates that make sense for music; anything else is a mis-parse. */
function plausibleBitrate(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 32 && number <= 1411 ? number : null;
}

function describeStream(src) {
  if (typeof src !== 'string' || src === '') return { url: null, codec: null, bitrateKbps: null };

  let codec = null;
  let bitrateKbps = null;

  // A codec token in the path carries both the codec and often the bitrate.
  const token = CODEC_TOKEN.exec(src);
  if (token) {
    codec = CODEC_NAMES[token[1].toLowerCase()] ?? null;
    bitrateKbps = plausibleBitrate(token[2]);
  }

  // An explicit `codec=` parameter names the codec unambiguously.
  if (!codec) {
    const codecParam = /[?&]codec=([^&#]+)/i.exec(src);
    if (codecParam) {
      for (const entry of RFC_CODEC_NAMES) {
        if (entry.pattern.test(codecParam[1])) {
          codec = entry.name;
          break;
        }
      }
    }
  }

  // Bitrate is only taken from a marker that names it, never a bare number.
  if (bitrateKbps === null) {
    // Path form: a codec segment immediately followed by a numeric segment,
    // e.g. `/aac/192/track`. The codec context is what makes this safe.
    const pathForm = /(?:^|\/)(?:aac|mp3|flac|opus)\/(\d{2,4})(?=\/|$)/i.exec(src);
    if (pathForm) bitrateKbps = plausibleBitrate(pathForm[1]);
  }

  if (bitrateKbps === null) {
    const explicit =
      /[?&]bitrate=(\d{2,4})/i.exec(src) ||
      /[?&](?:ab|abr)=(\d{2,4})/i.exec(src) ||
      /(\d{2,4})\s*kbps/i.exec(src);
    if (explicit) bitrateKbps = plausibleBitrate(explicit[1]);
  }

  return { url: src, codec, bitrateKbps };
}

class PlayerMonitor extends EventEmitter {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.webContents = null;
    this.ready = false;
    this.installing = false;
    this.timer = null;
    this.disposed = false;
    this.state = this.#emptyState();
    this.consecutiveFailures = 0;
    /** Latest audio URL seen on the network layer (MSE hides it from the DOM). */
    this.observedStreamUrl = null;
    /** Last stream URL that could not be classified; used to avoid log spam. */
    this.lastUnrecognisedStreamUrl = null;
  }

  #emptyState() {
    return {
      hasTrack: false,
      title: null,
      artist: null,
      album: null,
      coverUrl: null,
      isPlaying: false,
      playbackState: 'none',
      duration: null,
      position: null,
      volume: null,
      muted: null,
      updatedAt: 0,
    };
  }

  attach(webContents) {
    if (this.webContents === webContents) return;
    this.detach();
    this.webContents = webContents;
    this.logger.info('PlayerMonitor attached');

    // The probe lives in the page, so it must be re-installed on every load.
    // One load fires several navigation events, and the install is async, so an
    // explicit in-flight flag is needed to avoid installing it three times.
    const reinstall = (force = false) => {
      if (this.installing) return;
      if (!force && this.ready) return;
      this.installing = true;
      this.ready = false;
      this.#installProbe()
        .catch((error) => this.logger.warn('Probe install failed:', error.message))
        .finally(() => {
          this.installing = false;
        });
    };
    const events = ['did-finish-load', 'did-navigate', 'did-navigate-in-page'];
    const handlers = events.map((eventName) => {
      const handler = () => reinstall();
      webContents.on(eventName, handler);
      return [eventName, handler];
    });
    this.disposers = handlers.map(([eventName, handler]) => () => {
      webContents.removeListener(eventName, handler);
    });

    reinstall(true);
    this.timer = setInterval(() => this.#poll(), POLL_INTERVAL_MS);
  }

  detach() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const dispose of this.disposers ?? []) dispose();
    this.disposers = [];
    this.webContents = null;
    this.ready = false;
    this.installing = false;
  }

  dispose() {
    this.disposed = true;
    this.detach();
    this.removeAllListeners();
  }

  async #installProbe() {
    if (!this.#alive()) return;
    const version = await this.webContents.executeJavaScript(INSTALL_SOURCE, true);
    this.ready = true;
    this.logger.debug('Renderer probe installed, version', version);
  }

  #alive() {
    return Boolean(
      !this.disposed &&
        this.webContents &&
        !this.webContents.isDestroyed() &&
        !this.webContents.isCrashed?.(),
    );
  }

  async #poll() {
    if (!this.#alive()) return;
    let snapshot;
    try {
      snapshot = await this.webContents.executeJavaScript(SNAPSHOT_SOURCE, true);
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      // A load in flight makes execution fail transiently; only report real trouble.
      if (this.consecutiveFailures === 5) {
        this.logger.warn('Player probe unreachable:', error.message);
        this.ready = false;
      }
      return;
    }

    if (!snapshot) {
      this.ready = false;
      return;
    }
    this.ready = true;
    this.#apply(snapshot);
  }

  #apply(snapshot) {
    const previous = this.state;
    const next = this.#normalize(snapshot);

    const trackChanged =
      previous.title !== next.title || previous.artist !== next.artist || previous.album !== next.album;
    const playbackChanged = previous.isPlaying !== next.isPlaying;

    this.state = next;
    this.emit('state', next);
    if (trackChanged) this.emit('track', next, previous);
    if (playbackChanged) this.emit('playback', next, previous);
  }

  /** Records an audio URL observed on the network layer. */
  observeStream(url) {
    if (typeof url !== 'string' || !url) return;
    if (this.observedStreamUrl === url) return;
    this.observedStreamUrl = url;
    const stream = describeStream(url);
    if (stream.codec && stream.codec !== this.state.codec) {
      this.logger.info(
        `Stream codec: ${stream.codec}${stream.bitrateKbps ? ` ${stream.bitrateKbps} kbps` : ''}`,
      );
      // Re-emit so consumers (mini player, presence) pick the value up without
      // waiting for the next poll.
      this.emit('state', this.state);
    }
  }

  #normalize(snapshot) {
    const media = snapshot.media ?? null;
    const playing =
      snapshot.playbackState === 'playing' || (media ? media.paused === false : false);

    const duration = firstFinite(media?.duration, snapshot.sessionDuration);
    const position = this.#resolvePosition(snapshot, media, playing, duration);

    // `currentSrc` is a blob: URL under MSE, so the real stream URL has to come
    // from elsewhere. Three sources are tried, cheapest first: a direct element
    // URL, the renderer's resource timing buffer, and the network observer.
    const elementStream = describeStream(media?.src);
    const candidates = Array.isArray(snapshot.streamCandidates) ? snapshot.streamCandidates : [];
    let stream = elementStream;
    if (!stream.codec) {
      for (const candidate of candidates) {
        const described = describeStream(candidate);
        if (described.codec) {
          stream = described;
          break;
        }
      }
    }
    if (!stream.codec) stream = describeStream(this.observedStreamUrl);

    // Record the first unrecognised URL verbatim: if Yandex changes their
    // stream path scheme, this line is what makes it diagnosable.
    if (!stream.codec && candidates.length && candidates[0] !== this.lastUnrecognisedStreamUrl) {
      this.lastUnrecognisedStreamUrl = candidates[0];
      this.logger.debug('Unrecognised stream URL:', candidates[0]);
    }

    return {
      hasTrack: Boolean(snapshot.hasMetadata && (snapshot.title || snapshot.artist)),
      title: snapshot.title ?? null,
      artist: snapshot.artist ?? null,
      album: snapshot.album ?? null,
      coverUrl: pickCover(snapshot.artwork),
      isPlaying: playing,
      playbackState: snapshot.playbackState ?? 'none',
      duration,
      position,
      volume: media ? media.volume : null,
      muted: media ? media.muted : null,
      codec: stream.codec,
      bitrateKbps: stream.bitrateKbps,
      streamUrl: stream.url,
      updatedAt: Date.now(),
      raw: snapshot,
    };
  }

  /**
   * The media element reports the true playhead. When it is unavailable, fall
   * back to the last position the client published, advanced by elapsed time.
   */
  #resolvePosition(snapshot, media, playing, duration) {
    let position = null;

    if (media && typeof media.currentTime === 'number' && Number.isFinite(media.currentTime)) {
      position = media.currentTime;
    } else if (typeof snapshot.sessionPosition === 'number' && Number.isFinite(snapshot.sessionPosition)) {
      const elapsed = playing ? (snapshot.now - snapshot.sessionPositionAt) / 1000 : 0;
      position = snapshot.sessionPosition + Math.max(0, elapsed) * (snapshot.sessionRate || 1);
    }

    if (position === null) return null;
    if (typeof duration === 'number' && duration > 0) {
      return Math.max(0, Math.min(position, duration));
    }
    return Math.max(0, position);
  }

  // --- playback control ----------------------------------------------------

  sendAction(action) {
    if (!this.#alive()) return false;
    this.webContents.send(PLAYER_ACTION_CHANNEL, action);
    return true;
  }

  togglePlay() {
    return this.sendAction(this.state.isPlaying ? PLAYER_ACTION.PAUSE : PLAYER_ACTION.PLAY);
  }

  next() {
    return this.sendAction(PLAYER_ACTION.MOVE_FORWARD);
  }

  previous() {
    return this.sendAction(PLAYER_ACTION.MOVE_BACKWARD);
  }

  async setVolume(value) {
    if (!this.#alive()) return false;
    return this.webContents.executeJavaScript(CONTROL_SOURCE.setVolume(value), true);
  }

  async adjustVolume(delta) {
    const current = typeof this.state.volume === 'number' ? this.state.volume : 1;
    return this.setVolume(Math.max(0, Math.min(1, current + delta)));
  }

  async seek(seconds) {
    if (!this.#alive()) return false;
    return this.webContents.executeJavaScript(CONTROL_SOURCE.seek(seconds), true);
  }
}

function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

module.exports = {
  PlayerMonitor,
  PLAYER_ACTION,
  PLAYER_ACTION_CHANNEL,
  pickCover,
  describeStream,
};

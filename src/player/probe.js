'use strict';

/**
 * Reads the current track out of the renderer without patching its bundles.
 *
 * The vanilla client already maintains `navigator.mediaSession` for the OS
 * media keys: `AppMediaSession.updateMetadata()` publishes title/artist/album/
 * artwork through `MediaMetadata`, and `updatePositionState()` publishes
 * duration/position through `setPositionState()`. That is exactly the data
 * Rich Presence needs, so instead of rewriting minified chunks we observe those
 * two entry points from the main process via `executeJavaScript`.
 *
 * `setPositionState` is wrapped to remember the last reported position, since
 * MediaSession exposes no getter for it. Live progress is then either the
 * tracked media element's `currentTime` (precise) or the remembered position
 * extrapolated by wall-clock while playing.
 *
 * The probe must be re-installed after every navigation, because the renderer
 * is a single-page app that reloads on updates and window recreation.
 */

/** Runs inside the renderer's main world. Installs the probe; returns a version tag. */
function installProbe() {
  const PROBE_VERSION = 3;
  const existing = window.__itirpcProbe;
  if (existing && existing.version === PROBE_VERSION) return PROBE_VERSION;

  const state = {
    duration: null,
    position: null,
    positionAt: 0,
    rate: 1,
  };

  /** Media elements the player created; it uses `new Audio()`, so none are in the DOM. */
  const mediaElements = [];

  /**
   * Remembers a media element, without replacing any host constructor.
   *
   * Two earlier approaches were rejected. Wrapping `window.Audio` and
   * `document.createElement` replaced globals the entire renderer depends on,
   * which is far too invasive to observe a player. Querying the DOM alone finds
   * nothing, because the client's player is a detached `new Audio()`.
   *
   * Hooking one prototype method is the middle ground: `play()` is how any media
   * element starts, `this` is that element, and the hook only observes — the
   * original is always called with the original arguments and its result is
   * returned untouched.
   */
  const remember = (element) => {
    if (!element) return element;
    if (!mediaElements.includes(element)) {
      mediaElements.push(element);
      if (mediaElements.length > 8) mediaElements.shift();
    }
    return element;
  };

  if (typeof HTMLMediaElement !== 'undefined' && !HTMLMediaElement.prototype.__itirpcHooked) {
    const nativePlay = HTMLMediaElement.prototype.play;
    if (typeof nativePlay === 'function') {
      HTMLMediaElement.prototype.play = function play(...args) {
        try {
          remember(this);
        } catch {
          // Observing must never interfere with playback.
        }
        return nativePlay.apply(this, args);
      };
      HTMLMediaElement.prototype.__itirpcHooked = true;
    }
  }

  const mediaSession = navigator.mediaSession;
  if (mediaSession && typeof mediaSession.setPositionState === 'function' && !mediaSession.__itirpcWrapped) {
    const nativeSetPositionState = mediaSession.setPositionState.bind(mediaSession);
    const wrapped = function setPositionState(descriptor) {
      try {
        if (descriptor && typeof descriptor.duration === 'number' && Number.isFinite(descriptor.duration)) {
          state.duration = descriptor.duration;
          state.position = typeof descriptor.position === 'number' ? descriptor.position : 0;
          state.positionAt = Date.now();
          state.rate = typeof descriptor.playbackRate === 'number' ? descriptor.playbackRate : 1;
        } else {
          state.duration = null;
          state.position = null;
        }
      } catch {
        // Never let bookkeeping break the client's own media session updates.
      }
      return nativeSetPositionState(descriptor);
    };
    wrapped.__itirpcWrapped = true;
    try {
      mediaSession.setPositionState = wrapped;
      mediaSession.__itirpcWrapped = true;
    } catch {
      Object.defineProperty(mediaSession, 'setPositionState', { value: wrapped, configurable: true });
    }
  }

  /**
   * Picks the media element that is actually producing sound.
   *
   * The client uses a detached `new Audio()`, and it also plays short UI sounds
   * through other elements, so a naive "first element with a duration" picks a
   * 15-millisecond blip and reports it as the track. The order below is what
   * makes this reliable:
   *
   *   1. an element that is genuinely playing (furthest playhead wins);
   *   2. otherwise the element with the longest timeline — the track, not a blip;
   *   3. otherwise the most recently seen element.
   *
   * Returns null when the player has not started yet, in which case callers fall
   * back to the position and duration published through the media session.
   */
  const pickMedia = () => {
    const candidates = [...mediaElements, ...document.querySelectorAll('audio, video')].filter(Boolean);
    if (candidates.length === 0) return null;

    const playing = candidates.filter((element) => !element.paused);
    if (playing.length > 0) {
      return playing.reduce((a, b) => ((b.currentTime || 0) > (a.currentTime || 0) ? b : a));
    }

    const timed = candidates.filter((element) => Number.isFinite(element.duration) && element.duration > 0);
    if (timed.length > 0) {
      return timed.reduce((a, b) => (b.duration > a.duration ? b : a));
    }

    return candidates[candidates.length - 1];
  };

  /**
   * Recent media-related resource URLs, newest first.
   *
   * Telemetry and artwork share the stream hosts (`log.strm.yandex.ru/log?...`,
   * `avatars.mds.yandex.net/...`), so hosts are filtered rather than just
   * matched by substring.
   */
  const recentStreamUrls = () => {
    try {
      const entries = performance.getEntriesByType('resource');
      const out = [];
      for (let i = entries.length - 1; i >= 0 && out.length < 5; i -= 1) {
        const name = entries[i] && entries[i].name;
        if (typeof name !== 'string') continue;
        let parsed;
        try {
          parsed = new URL(name);
        } catch {
          continue;
        }
        if (/^(avatars|log|favicon|cdn)\./i.test(parsed.hostname)) continue;
        if (!/(^|\.)(strm|mds|s3)\.yandex\.(net|ru)$/i.test(parsed.hostname)) continue;
        if (/^\/(log|perf)\b/i.test(parsed.pathname)) continue;
        out.push(name);
      }
      return out;
    } catch {
      return [];
    }
  };

  window.__itirpcProbe = {
    version: PROBE_VERSION,

    snapshot() {
      const session = navigator.mediaSession;
      const metadata = session ? session.metadata : null;
      const media = pickMedia();
      return {
        version: PROBE_VERSION,
        hasMetadata: Boolean(metadata),
        title: metadata ? metadata.title || null : null,
        artist: metadata ? metadata.artist || null : null,
        album: metadata ? metadata.album || null : null,
        artwork:
          metadata && metadata.artwork
            ? Array.from(metadata.artwork).map((art) => ({ src: art.src, sizes: art.sizes }))
            : [],
        playbackState: session ? session.playbackState : null,
        /**
         * Audio segments fetched through Media Source Extensions never appear
         * in `media.src`, but they do show up in the resource timing buffer.
         */
        streamCandidates: recentStreamUrls(),
        sessionDuration: state.duration,
        sessionPosition: state.position,
        sessionPositionAt: state.positionAt,
        sessionRate: state.rate,
        media: media
          ? {
              currentTime: Number.isFinite(media.currentTime) ? media.currentTime : null,
              duration: Number.isFinite(media.duration) ? media.duration : null,
              paused: media.paused,
              volume: media.volume,
              muted: media.muted,
              playbackRate: media.playbackRate,
              // Stream URL: the only place the codec/bitrate is observable from
              // outside the client's own player internals.
              src: media.currentSrc || media.src || null,
            }
          : null,
        now: Date.now(),
      };
    },

    /** Volume/mute are only reachable through the element itself. */
    setVolume(value) {
      const media = pickMedia();
      if (!media) return false;
      media.volume = Math.max(0, Math.min(1, value));
      return true;
    },

    setMuted(muted) {
      const media = pickMedia();
      if (!media) return false;
      media.muted = Boolean(muted);
      return true;
    },

    /** Seeks through the media element; used by the mini player scrubber. */
    seek(seconds) {
      const media = pickMedia();
      if (!media) return false;
      media.currentTime = seconds;
      return true;
    },
  };

  return PROBE_VERSION;
}

const INSTALL_SOURCE = `(${installProbe.toString()})()`;
const SNAPSHOT_SOURCE = `(window.__itirpcProbe ? window.__itirpcProbe.snapshot() : null)`;

/** Methods we expose to the rest of the mod, forwarded into the renderer. */
const CONTROL_SOURCE = {
  setVolume: (value) => `(window.__itirpcProbe ? window.__itirpcProbe.setVolume(${Number(value)}) : false)`,
  setMuted: (muted) => `(window.__itirpcProbe ? window.__itirpcProbe.setMuted(${Boolean(muted)}) : false)`,
  seek: (seconds) => `(window.__itirpcProbe ? window.__itirpcProbe.seek(${Number(seconds)}) : false)`,
};

module.exports = { INSTALL_SOURCE, SNAPSHOT_SOURCE, CONTROL_SOURCE, installProbe };

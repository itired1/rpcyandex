'use strict';

/**
 * Last.fm scrobbling.
 *
 * Playback time is measured with wall-clock deltas while the player reports
 * "playing", not from the reported playhead. That matches how Last.fm defines a
 * scrobble and makes seeking harmless: jumping forward does not fake listening
 * time, and pausing stops the clock.
 *
 * A track is submitted when the client moves to another track, and also when
 * playback pauses — the request itself is sent at the transition, which is what
 * the client's own event stream gives us.
 */

const electron = require('electron');
const {
  LastFmApi,
  LastFmError,
  isEligibleForScrobble,
  scrobbleThresholdSeconds,
} = require('./api');

/** Ignore generative/placeholder entries that have no real artist. */
function isScrobblable(state) {
  if (!state?.hasTrack || !state.title) return false;
  if (!state.artist) return false;
  if (typeof state.title === 'string' && state.title.startsWith('generative')) return false;
  return true;
}

function trackKey(state) {
  return `${state.artist ?? ''}\u0000${state.title ?? ''}\u0000${state.album ?? ''}`;
}

class LastFmScrobbler {
  constructor({ settings, player, logger }) {
    this.settings = settings;
    this.player = player;
    this.logger = logger;
    this.current = null;
    this.lastState = null;
    this.lastTickAt = 0;
    this.nowPlayingSentFor = null;
  }

  get config() {
    return this.settings.get('lastfm') ?? {};
  }

  get api() {
    const { apiKey, sharedSecret } = this.config;
    return new LastFmApi({
      apiKey,
      sharedSecret,
      logger: this.logger,
    });
  }

  get sessionKey() {
    return this.config.sessionKey || null;
  }

  get status() {
    return {
      enabled: Boolean(this.config.enabled),
      configured: this.api.configured,
      authenticated: Boolean(this.sessionKey),
      username: this.config.username || null,
      nowPlaying: this.current
        ? { ...this.current, threshold: scrobbleThresholdSeconds(this.current.duration) }
        : null,
    };
  }

  start() {
    this.player.on('state', this.#onState);
    // Flush a pending scrobble when the client shuts down.
    electron.app.on('will-quit', () => this.flush('shutdown'));
    this.logger.info(
      `Last.fm: ${this.config.enabled ? 'enabled' : 'disabled'}, ` +
        `${this.api.configured ? 'API key set' : 'no API key'}, ` +
        `${this.sessionKey ? `signed in as ${this.config.username ?? 'unknown'}` : 'not signed in'}`,
    );
  }

  stop() {
    this.player.removeListener('state', this.#onState);
  }

  // --- authorization -------------------------------------------------------

  /**
   * Runs the Last.fm web-auth flow: fetch a token, let the user approve it in a
   * browser window, then exchange it for a session key.
   * @returns {Promise<{ok: boolean, username?: string, error?: string}>}
   */
  async authorize() {
    const api = this.api;
    if (!api.configured) {
      return {
        ok: false,
        error: 'Не заданы lastfm.apiKey и lastfm.sharedSecret в config.json',
      };
    }

    let token;
    try {
      token = await api.getToken();
    } catch (error) {
      return { ok: false, error: `Не удалось получить токен: ${error.message}` };
    }

    const authorized = await this.#promptForAuthorization(api.authorizationUrl(token));
    if (!authorized) return { ok: false, error: 'Окно авторизации было закрыто' };

    try {
      const session = await api.getSession(token);
      this.settings.set('lastfm.sessionKey', session.key);
      this.settings.set('lastfm.username', session.name);
      this.settings.set('lastfm.enabled', true);
      this.logger.info('Last.fm: signed in as', session.name);
      return { ok: true, username: session.name };
    } catch (error) {
      return { ok: false, error: `Не удалось получить сессию: ${error.message}` };
    }
  }

  signOut() {
    this.settings.set('lastfm.sessionKey', '');
    this.settings.set('lastfm.username', '');
    this.current = null;
    this.logger.info('Last.fm: signed out');
  }

  /** Opens the approval page; resolves true when the user finished the flow. */
  #promptForAuthorization(url) {
    return new Promise((resolve) => {
      const window = new electron.BrowserWindow({
        width: 480,
        height: 640,
        title: 'Авторизация Last.fm',
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      let approved = false;

      // Last.fm shows a success banner on the same page after approval; watch
      // for it so the window can close itself and the flow can continue.
      const poll = setInterval(() => {
        if (window.isDestroyed()) return;
        window.webContents
          .executeJavaScript(
            `Boolean(document.querySelector('.alert-success')) ||
             /you have granted access/i.test(document.body ? document.body.innerText : '')`,
            true,
          )
          .then((done) => {
            if (done) {
              approved = true;
              clearInterval(poll);
              if (!window.isDestroyed()) window.close();
            }
          })
          .catch(() => {
            // Page still navigating; try again on the next tick.
          });
      }, 1000);

      window.on('closed', () => {
        clearInterval(poll);
        resolve(approved);
      });

      window.loadURL(url).catch((error) => {
        this.logger.warn('Last.fm authorization window failed to load:', error.message);
        clearInterval(poll);
        if (!window.isDestroyed()) window.destroy();
        resolve(false);
      });
    });
  }

  // --- playback accounting -------------------------------------------------

  /**
   * The single place that converts elapsed wall-clock time into played time.
   * Called once per state tick, so a track can never be credited twice.
   */
  #creditElapsed(now = Date.now()) {
    if (this.current && this.lastState?.isPlaying) {
      this.current.playedMs += Math.max(0, now - this.lastTickAt);
    }
    this.lastTickAt = now;
  }

  #onState = (state) => {
    const now = Date.now();
    this.#creditElapsed(now);

    const previousState = this.lastState;
    this.lastState = state;

    if (!isScrobblable(state)) {
      if (this.current) this.#finalize('track no longer playable');
      return;
    }

    const key = trackKey(state);
    if (this.current && this.current.key !== key) {
      this.#finalize('track changed');
    }

    if (!this.current) {
      this.current = {
        key,
        title: state.title,
        artist: state.artist,
        album: state.album,
        duration: state.duration ?? null,
        playedMs: 0,
        startedAt: now,
        scrobbled: false,
        nowPlayingSent: false,
      };
    } else if (state.duration) {
      // Duration often arrives a moment after the title does.
      this.current.duration = state.duration;
    }

    this.#sendNowPlaying();

    // A pause is the second point at which a scrobble may be due.
    if (previousState?.isPlaying && !state.isPlaying) {
      this.#maybeScrobble('paused');
    }
  };

  #sendNowPlaying() {
    const track = this.current;
    const api = this.api;
    if (!track || track.nowPlayingSent || !this.config.enabled || !this.sessionKey || !api.configured) return;

    track.nowPlayingSent = true;
    api
      .updateNowPlaying(this.sessionKey, track)
      .then(() => this.logger.debug('Last.fm now playing:', track.artist, '—', track.title))
      .catch((error) => {
        track.nowPlayingSent = false; // allow a retry on the next state tick
        this.logger.warn('Last.fm updateNowPlaying failed:', error.message);
      });
  }

  #maybeScrobble(reason) {
    const track = this.current;
    if (!track || track.scrobbled) return;
    if (!this.config.enabled || !this.sessionKey || !this.api.configured) return;
    if (!isEligibleForScrobble(track.duration, track.playedMs / 1000)) return;

    track.scrobbled = true;
    const threshold = scrobbleThresholdSeconds(track.duration);
    this.logger.info(
      `Last.fm scrobble (${reason}): ${track.artist} — ${track.title} ` +
        `[${(track.playedMs / 1000).toFixed(0)}s of ${track.duration?.toFixed(0) ?? '?'}s, threshold ${threshold?.toFixed(0)}s]`,
    );

    this.api
      .scrobble(this.sessionKey, track, track.startedAt / 1000)
      .catch((error) => {
        // Allow another attempt later rather than losing the scrobble.
        track.scrobbled = false;
        if (error instanceof LastFmError && error.code === 9) {
          this.logger.warn('Last.fm rejected the session key; sign in again');
        } else {
          this.logger.warn('Last.fm scrobble failed:', error.message);
        }
      });
  }

  /**
   * Ends the current track, submitting it if it qualifies. Elapsed time is
   * expected to have been credited already by `#creditElapsed`.
   */
  #finalize(reason) {
    const track = this.current;
    if (!track) return;
    this.#maybeScrobble(reason);
    this.current = null;
  }

  /** Flushes on shutdown, crediting whatever was playing up to this moment. */
  flush(reason) {
    this.#creditElapsed();
    this.#finalize(reason);
  }
}

module.exports = { LastFmScrobbler, isScrobblable, trackKey };

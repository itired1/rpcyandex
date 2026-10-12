'use strict';

/**
 * Last.fm API client.
 *
 * Implemented against the documented 2.0 web service so no npm dependency is
 * needed inside app.asar. Credentials are never bundled: the user registers
 * their own API key and supplies it through settings, which is also what the
 * service's terms expect for a client like this.
 *
 * Two signing modes exist and the difference matters:
 *  - `auth.getToken` / `auth.getSession` are signed without the session key;
 *  - everything else is a POST signed with both the shared secret and `sk`.
 */

const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const AUTH_URL = 'https://www.last.fm/api/auth/';

/** Last.fm ignores tracks shorter than this entirely. */
const MIN_TRACK_DURATION_SECONDS = 30;
/** Never require more than four minutes of listening, however long the track is. */
const MAX_SCROBBLE_THRESHOLD_SECONDS = 240;

class LastFmError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LastFmError';
    this.code = code;
  }
}

/**
 * md5 of the sorted `key+value` concatenation followed by the shared secret.
 * `format` and `callback` are excluded because Last.fm does not sign them.
 */
function signParams(params, sharedSecret) {
  const payload = Object.keys(params)
    .filter((key) => key !== 'format' && key !== 'callback')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
  return crypto.createHash('md5').update(payload + sharedSecret, 'utf8').digest('hex');
}

class LastFmApi {
  constructor({ apiKey, sharedSecret, baseUrl, logger }) {
    this.apiKey = apiKey;
    this.sharedSecret = sharedSecret;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.logger = logger;
  }

  get configured() {
    return Boolean(this.apiKey && this.sharedSecret);
  }

  #signature(params) {
    return signParams(params, this.sharedSecret);
  }

  async #call(method, params = {}, options = {}) {
    if (!this.configured) throw new LastFmError('Last.fm API key or shared secret is not configured');

    const { signed = true, sessionKey = null, httpMethod = 'POST' } = options;

    const body = new URLSearchParams();
    body.set('method', method);
    body.set('api_key', this.apiKey);
    body.set('format', 'json');
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') body.set(key, String(value));
    }
    if (sessionKey) body.set('sk', sessionKey);
    if (signed) body.set('api_sig', this.#signature(Object.fromEntries(body.entries())));

    const url = httpMethod === 'GET' ? `${this.baseUrl}?${body.toString()}` : this.baseUrl;
    const response = await fetch(url, {
      method: httpMethod,
      headers: httpMethod === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
      body: httpMethod === 'POST' ? body.toString() : undefined,
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new LastFmError(`Last.fm returned a non-JSON response (HTTP ${response.status})`);
    }

    if (payload.error) {
      throw new LastFmError(payload.message || `Last.fm error ${payload.error}`, payload.error);
    }
    return payload;
  }

  // --- authentication ------------------------------------------------------

  /** Step 1: an unsigned request for a token to show the user. */
  async getToken() {
    const payload = await this.#call('auth.getToken', {}, { signed: false, httpMethod: 'GET' });
    return payload.token;
  }

  /** URL the user must open to grant access to their account. */
  authorizationUrl(token) {
    return `${AUTH_URL}?api_key=${encodeURIComponent(this.apiKey)}&token=${encodeURIComponent(token)}`;
  }

  /** Step 2: exchange the approved token for a permanent session key. */
  async getSession(token) {
    const payload = await this.#call('auth.getSession', { token }, { signed: true, httpMethod: 'GET' });
    if (!payload.session?.key) throw new LastFmError('Last.fm did not return a session key');
    return payload.session;
  }

  // --- scrobbling ----------------------------------------------------------

  async updateNowPlaying(sessionKey, track) {
    return this.#call(
      'track.updateNowPlaying',
      this.#trackParams(track),
      { sessionKey },
    );
  }

  async scrobble(sessionKey, track, timestampSeconds) {
    return this.#call(
      'track.scrobble',
      { ...this.#trackParams(track), timestamp: Math.floor(timestampSeconds) },
      { sessionKey },
    );
  }

  async getUserInfo(sessionKey) {
    return this.#call('user.getInfo', {}, { sessionKey, httpMethod: 'GET' });
  }

  #trackParams(track) {
    return {
      artist: track.artist,
      track: track.title,
      album: track.album || undefined,
      duration: track.duration ? Math.round(track.duration) : undefined,
    };
  }
}

/**
 * Last.fm's own rule: a track scrobbles once the user has listened to at least
 * half of it, or four minutes, whichever comes first.
 */
function scrobbleThresholdSeconds(durationSeconds) {
  if (!durationSeconds || durationSeconds < MIN_TRACK_DURATION_SECONDS) return null;
  return Math.min(durationSeconds / 2, MAX_SCROBBLE_THRESHOLD_SECONDS);
}

/** Whether the track is long enough and was played long enough to count. */
function isEligibleForScrobble(durationSeconds, playedSeconds) {
  const threshold = scrobbleThresholdSeconds(durationSeconds);
  if (threshold === null) return false;
  return playedSeconds >= threshold;
}

module.exports = {
  LastFmApi,
  LastFmError,
  signParams,
  scrobbleThresholdSeconds,
  isEligibleForScrobble,
  MIN_TRACK_DURATION_SECONDS,
  MAX_SCROBBLE_THRESHOLD_SECONDS,
  DEFAULT_BASE_URL,
  AUTH_URL,
};

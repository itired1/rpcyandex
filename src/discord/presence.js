'use strict';

/**
 * Keeps Discord's Rich Presence in sync with the player.
 *
 * Three behaviours matter here and are all deliberate:
 *
 *  - **Throttling.** Discord rate-limits SET_ACTIVITY; the player state changes
 *    every second, so updates are coalesced and only sent when something the
 *    user can actually see changed, or when the progress bar has drifted.
 *    Pause and resume are the exception: they are pushed as soon as they are
 *    observed, so the presence never keeps claiming to be playing.
 *  - **Heartbeat.** A presence that is sent once can silently disappear after
 *    about a minute (a long-standing Discord RPC complaint). Re-asserting the
 *    same activity on an interval keeps it alive.
 *  - **Idle clear.** After a configurable pause the presence is cleared instead
 *    of claiming the user is still listening.
 */

const { DiscordIpc } = require('./ipc');
const { buildActivity, stripOptionalFields, activitiesEqual } = require('./activity');

/** Discord rejects updates that arrive faster than this. */
const MIN_SEND_INTERVAL_MS = 3000;
/**
 * Pause and resume are pushed as soon as they are observed instead of waiting
 * out MIN_SEND_INTERVAL_MS, because they are the one change a user watches for.
 * Kept well above the fastest possible manual toggle so the service's rate limit
 * cannot be reached by accident.
 */
const TRANSITION_SEND_INTERVAL_MS = 1200;
/** Re-assert the activity this often so it cannot fade out. */
const HEARTBEAT_MS = 30_000;
/** Scheduler resolution; cheap because it only compares plain objects. */
const TICK_MS = 2000;
/** Re-send when the progress bar would be visibly stale. */
const TIMESTAMP_DRIFT_MS = 5000;
/** A playhead jump larger than this is treated as a seek and re-anchors. */
const SEEK_TOLERANCE_SECONDS = 2.5;

/**
 * True when the progress bar of the sent activity no longer matches the one we
 * would send now.
 *
 * The asymmetric case matters most: while paused only one of the two activities
 * carries timestamps, and requiring *both* made this check unreachable exactly
 * when the pause needed to reach Discord. Because it short-circuited to false,
 * a pause stayed invisible until the 30 second heartbeat happened to fire — the
 * reported "10-20 seconds".
 */
function timestampsDrifted(sent, desired) {
  const sentStamps = sent?.timestamps;
  const nextStamps = desired?.timestamps;
  if (!sentStamps || !nextStamps) return Boolean(sentStamps) !== Boolean(nextStamps);
  return Math.abs(sentStamps.start - nextStamps.start) >= TIMESTAMP_DRIFT_MS;
}

/**
 * Decides whether `desired` has to be pushed to Discord, and why.
 *
 * Pure, and free of any socket, so the timing policy — the part that used to
 * swallow a pause for up to a full heartbeat interval — can be tested directly.
 *
 * @param {object} desired     activity that would be sent now, or null.
 * @param {object} sent        activity currently on screen, or null.
 * @param {number} sentAtMs    when `sent` was pushed.
 * @param {number} nowMs       current time.
 * @param {boolean} [force]    this is a pause/resume the user just triggered.
 * @returns {'change'|'heartbeat'|'drift'|null} null means "send nothing".
 */
function sendReason(desired, sent, sentAtMs, nowMs, force = false) {
  if (!desired) return null;

  const sinceSent = nowMs - sentAtMs;
  const floor = force ? TRANSITION_SEND_INTERVAL_MS : MIN_SEND_INTERVAL_MS;
  if (sinceSent < floor) return null;

  if (!sent || !activitiesEqual(desired, sent)) return 'change';
  if (sinceSent >= HEARTBEAT_MS) return 'heartbeat';
  if (timestampsDrifted(sent, desired)) return 'drift';
  return null;
}

class DiscordPresence {
  constructor({ settings, player, logger, locale }) {
    this.settings = settings;
    this.player = player;
    this.logger = logger;
    this.locale = locale;
    this.ipc = null;
    this.tickTimer = null;
    this.reconnectTimer = null;
    this.state = null;
    this.sentActivity = null;
    this.sentAt = 0;
    this.pausedSince = null;
    this.strippedRetryUsed = false;
    this.stopped = true;
    /** Stable progress anchor for the current track; see #applyTimestamps. */
    this.anchor = null;
  }

  get config() {
    return this.settings.get('discord') ?? {};
  }

  get enabled() {
    return Boolean(this.config.enabled && this.config.clientId);
  }

  start() {
    this.stopped = false;
    this.player.on('state', this.#onState);

    if (!this.config.enabled) {
      this.logger.info('Discord RPC disabled in settings');
      return;
    }
    if (!this.config.clientId) {
      this.logger.warn(
        'Discord RPC is enabled but no clientId is configured. Create an application at ' +
          'https://discord.com/developers/applications and set discord.clientId in config.json.',
      );
      return;
    }

    this.tickTimer = setInterval(() => this.#tick(), TICK_MS);
    this.#connect();
  }

  stop() {
    this.stopped = true;
    this.player.removeListener('state', this.#onState);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.tickTimer = null;
    this.reconnectTimer = null;
    this.ipc?.destroy();
    this.ipc = null;
  }

  #onState = (state) => {
    const wasPlaying = this.state?.isPlaying;
    const wasTitle = this.state?.title ?? null;
    const nowTitle = state.title ?? null;

    this.state = state;

    // Only report real transitions; the first poll of an idle client would
    // otherwise log "null — null" and look like a failure.
    if (nowTitle && (wasTitle !== nowTitle || this.state?.artist !== state.artist)) {
      this.logger.info('Presence track:', state.title, '—', state.artist);
    }

    if (state.isPlaying) {
      this.pausedSince = null;
    } else if (wasPlaying && this.pausedSince === null) {
      this.pausedSince = Date.now();
    }

    // Waiting for the next tick meant up to two seconds of the previous activity
    // still on screen — with its progress bar running — right after the user hit
    // pause. A transition is sent as soon as it is observed instead.
    if (wasPlaying !== undefined && state.isPlaying !== wasPlaying) {
      this.logger.debug(state.isPlaying ? 'Presence resumed' : 'Presence paused');
      this.#tick(true);
    }
  };

  #connect() {
    if (this.stopped || !this.enabled) return;
    if (this.ipc) this.ipc.destroy();

    const ipc = new DiscordIpc({
      clientId: this.config.clientId,
      logger: this.logger,
    });
    this.ipc = ipc;

    ipc.on('ready', () => {
      this.sentActivity = null; // force a full re-send after a reconnect
      this.strippedRetryUsed = false;
      this.#tick();
    });

    ipc.on('disconnected', (error) => {
      this.logger.debug('Discord RPC disconnected:', error?.message ?? 'unknown');
      this.ipc = null;
      this.#scheduleReconnect();
    });

    ipc.on('rpc-error', () => {
      // Newer activity fields are occasionally rejected; retry once without
      // them rather than dropping the presence entirely.
      if (this.strippedRetryUsed) return;
      this.strippedRetryUsed = true;
      const minimal = stripOptionalFields(this.sentActivity);
      if (minimal) {
        this.logger.warn('Discord rejected the activity; retrying without optional fields');
        ipc.setActivity(minimal);
        this.sentActivity = minimal;
        this.sentAt = Date.now();
      }
    });

    ipc.connect().then((connected) => {
      if (!connected && !this.stopped) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = Math.max(5, Number(this.config.reconnectIntervalSeconds) || 30) * 1000;
    this.logger.debug(`Reconnecting to Discord in ${delayMs / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delayMs);
  }

  #trackKey(state) {
    return `${state?.title ?? ''}\u0000${state?.artist ?? ''}\u0000${state?.album ?? ''}`;
  }

  /**
   * Anchors the progress timestamps once per track instead of recomputing them
   * on every poll.
   *
   * Recomputing `now - position` each tick made the start time jitter by a few
   * milliseconds every second, so every activity looked "changed" and Discord
   * was re-sent every four seconds — 117 times in one session, right at the
   * service's rate limit. The anchor is rebuilt only when the track changes, on
   * resume, or when the playhead jumps (a seek).
   */
  #applyTimestamps(activity) {
    if (!activity) return activity;

    const state = this.state ?? {};
    const anchored =
      state.isPlaying && typeof state.duration === 'number' && state.duration > 0;

    if (!anchored) {
      this.anchor = null;
      delete activity.timestamps;
      return activity;
    }

    const now = Date.now();
    const actual = typeof state.position === 'number' ? state.position : 0;
    const key = this.#trackKey(state);
    const expected = this.anchor ? (now - this.anchor.startMs) / 1000 : null;
    const needsAnchor =
      !this.anchor ||
      this.anchor.key !== key ||
      expected === null ||
      Math.abs(expected - actual) > SEEK_TOLERANCE_SECONDS;

    if (needsAnchor) {
      this.anchor = { key, startMs: Math.round(now - actual * 1000) };
    }

    activity.timestamps = {
      start: this.anchor.startMs,
      end: this.anchor.startMs + Math.round(state.duration * 1000),
    };
    return activity;
  }

  #tick(force = false) {
    if (this.stopped) return;
    const ipc = this.ipc;
    if (!ipc || !ipc.connected) return;

    // Idle: stop advertising playback the user walked away from.
    const idleMinutes = Number(this.config.idleTimeoutMinutes) || 0;
    const idle =
      idleMinutes > 0 &&
      !this.state?.isPlaying &&
      this.pausedSince !== null &&
      Date.now() - this.pausedSince > idleMinutes * 60_000;

    if (idle) {
      if (this.sentActivity !== null) {
        this.logger.info('Clearing Discord presence (idle)');
        ipc.setActivity(null);
        this.sentActivity = null;
        this.sentAt = Date.now();
      }
      return;
    }

    const desired = this.#applyTimestamps(buildActivity(this.state, this.config, this.locale));

    if (!desired) {
      if (this.sentActivity !== null) {
        this.logger.debug('Clearing Discord presence (nothing playing)');
        ipc.setActivity(null);
        this.sentActivity = null;
        this.sentAt = Date.now();
      }
      return;
    }

    const reason = sendReason(desired, this.sentActivity, this.sentAt, Date.now(), force);
    if (!reason) return;

    ipc.setActivity(desired);
    this.sentActivity = desired;
    this.sentAt = Date.now();
    this.logger.debug(
      reason === 'heartbeat' ? 'Discord presence heartbeat' : 'Discord presence updated',
      desired.details,
    );
  }
}

module.exports = {
  DiscordPresence,
  sendReason,
  timestampsDrifted,
  MIN_SEND_INTERVAL_MS,
  TRANSITION_SEND_INTERVAL_MS,
  HEARTBEAT_MS,
  TIMESTAMP_DRIFT_MS,
};


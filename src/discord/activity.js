'use strict';

/**
 * Turns a player state into a Discord activity payload.
 *
 * Kept separate from the transport so the mapping can be unit-tested and so the
 * fallback path (Discord builds that reject newer fields such as
 * `status_display_type`, `details_url` or `buttons`) has one obvious place to
 * strip them.
 */

const ACTIVITY_TYPE_LISTENING = 2;
const DISCORD_STRING_LIMIT = 128;
/** U+23F8 + variation selector, so Discord renders the pause glyph as emoji. */
const PAUSE_GLYPH = '\u23F8\uFE0F';

const STRINGS = {
  ru: {
    listening: 'Слушает',
    paused: 'На паузе',
    unknownArtist: 'Неизвестный исполнитель',
    openInYandexMusic: 'Открыть в Яндекс.Музыке',
    searchTrack: 'Найти трек',
  },
  en: {
    listening: 'Listening',
    paused: 'Paused',
    unknownArtist: 'Unknown artist',
    openInYandexMusic: 'Open in Yandex Music',
    searchTrack: 'Find this track',
  },
};

function resolveLanguage(language, locale) {
  if (language === 'ru' || language === 'en') return language;
  const tag = String(locale ?? '').toLowerCase();
  return tag.startsWith('ru') ? 'ru' : 'en';
}

function stringsFor(language, locale) {
  return STRINGS[resolveLanguage(language, locale)];
}

/**
 * Discord collapses single-character strings to nothing, and rejects anything
 * over 128 characters.
 */
function toDiscordString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length === 1) return `${trimmed}\u3164`;
  return trimmed.length > DISCORD_STRING_LIMIT ? trimmed.slice(0, DISCORD_STRING_LIMIT) : trimmed;
}

/** Public search URL — MediaMetadata carries no track id, so this is the honest link. */
function searchUrl(state) {
  const query = [state.title, state.artist].filter(Boolean).join(' ').trim();
  if (!query) return null;
  return `https://music.yandex.ru/search?text=${encodeURIComponent(query)}`;
}

/**
 * The second line of the presence.
 *
 * While playing it carries the artist/album line. While paused it carries an
 * explicit "paused" word instead: Discord has no paused state of its own, and
 * the only other signal — the absent progress bar — is invisible, because a
 * presence that is not re-sent keeps rendering with its old timestamps and a
 * progress bar that keeps advancing.
 */
function pickSecondaryText(state, displayType, strings) {
  if (!state.isPlaying) return `${PAUSE_GLYPH}\u00A0${strings.paused}`;
  switch (displayType) {
    case 'album':
      return state.album || state.artist;
    case 'minimal':
      return undefined;
    case 'details':
    default:
      if (state.artist && state.album) return `${state.artist} — ${state.album}`;
      return state.artist || state.album;
  }
}

/**
 * @param {object} state PlayerMonitor state.
 * @param {object} config  discord section of the settings.
 * @param {string} locale  Electron locale, used when language is 'auto'.
 * @returns {object|null} activity payload, or null when nothing should be shown.
 */
function buildActivity(state, config, locale) {
  if (!state?.hasTrack) return null;

  const strings = stringsFor(config.language, locale);
  const details = toDiscordString(state.title);
  if (!details) return null;

  const activity = {
    type: ACTIVITY_TYPE_LISTENING,
    details,
    state: toDiscordString(pickSecondaryText(state, config.displayType, strings)),
  };

  if (config.showTimestamps && state.isPlaying && state.duration > 0) {
    // Anchoring to the real playhead makes Discord's own progress bar correct
    // even after a seek; dropping the timestamps stops the bar outright, so a
    // paused presence cannot keep counting up.
    const now = Date.now();
    const start = now - Math.max(0, state.position ?? 0) * 1000;
    activity.timestamps = { start: Math.round(start), end: Math.round(start + state.duration * 1000) };
  }

  const assets = {};
  if (state.coverUrl) {
    // External https assets are proxied by Discord, so no upload is needed.
    assets.large_image = state.coverUrl;
    // `large_text` is intentionally left unset: the client frequently reports
    // `album` as the track title, so the line below the artwork printed the
    // words above it a second time instead of adding anything.
  }
  if (config.smallImageKey) {
    assets.small_image = config.smallImageKey;
    assets.small_text = toDiscordString(
      state.isPlaying ? strings.listening : strings.paused,
    );
  }
  if (Object.keys(assets).length) activity.assets = assets;

  if (config.showButtons) {
    const url = searchUrl(state);
    if (url) activity.buttons = [{ label: toDiscordString(strings.searchTrack), url }];
  }

  if (typeof config.statusDisplayType === 'number') {
    activity.status_display_type = config.statusDisplayType;
  }

  return activity;
}

/**
 * Drops the fields that older Discord builds reject, keeping the essentials.
 * Used as a one-shot retry after an RPC error.
 */
function stripOptionalFields(activity) {
  if (!activity) return activity;
  const { status_display_type, details_url, state_url, buttons, ...rest } = activity;
  return rest;
}

/**
 * True when the two activities would look identical to the user.
 *
 * Timestamps are deliberately compared only by *presence*, not by value: their
 * values drift by a few milliseconds on every poll and comparing them exactly
 * used to re-send the activity every few seconds. Their absence is a different
 * matter — a presence without a progress bar is how a pause is shown, so losing
 * or regaining them is a change the user can see and must be pushed at once.
 */
function activitiesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.details === b.details &&
    a.state === b.state &&
    a.type === b.type &&
    a.assets?.large_image === b.assets?.large_image &&
    a.assets?.large_text === b.assets?.large_text &&
    a.assets?.small_image === b.assets?.small_image &&
    a.assets?.small_text === b.assets?.small_text &&
    a.buttons?.[0]?.url === b.buttons?.[0]?.url &&
    Boolean(a.timestamps) === Boolean(b.timestamps)
  );
}

module.exports = {
  buildActivity,
  stripOptionalFields,
  activitiesEqual,
  resolveLanguage,
  stringsFor,
  toDiscordString,
  searchUrl,
  ACTIVITY_TYPE_LISTENING,
  DISCORD_STRING_LIMIT,
};

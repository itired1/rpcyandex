'use strict';

/**
 * Mini player renderer.
 *
 * Receives state from the main process and renders it. The progress bar is
 * interpolated locally between updates so it advances smoothly even though the
 * main process only polls the client once a second.
 *
 * Layout density is decided here rather than in CSS: a `ResizeObserver` measures
 * the window and publishes `data-density`, which is the single place where the
 * "how much fits" thresholds exist. The stylesheet only reacts to the value, so
 * a breakpoint can never disagree with the layout it is supposed to protect.
 */

const api = window.itirpcMini;
const elements = {
  root: document.getElementById('root'),
  cover: document.getElementById('cover'),
  title: document.getElementById('title'),
  artist: document.getElementById('artist'),
  codec: document.getElementById('codec'),
  elapsed: document.getElementById('elapsed'),
  duration: document.getElementById('duration'),
  progress: document.getElementById('progress'),
  progressFill: document.getElementById('progressFill'),
  toggle: document.getElementById('toggle'),
  iconPlay: document.getElementById('icon-play'),
  iconPause: document.getElementById('icon-pause'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  volumeUp: document.getElementById('volumeUp'),
  volumeDown: document.getElementById('volumeDown'),
  pin: document.getElementById('pin'),
  close: document.getElementById('close'),
};

const EMPTY_TITLE = 'Ничего не играет';

/**
 * The one and only definition of "how much fits".
 *
 * `short` keeps the artwork but drops the time row, which is what a wide window
 * dragged down to the minimum height actually needs.
 *
 * The numbers are what each tier needs to lay out, not round values: type scales
 * with width, so a wide window needs more height than a narrow one and the
 * thresholds alone are not enough. The sweep in scripts/run-tests.mjs recomputes
 * every figure from the stylesheet across the whole allowed size range, so
 * moving a clamp without moving this function fails the suite.
 */
function densityFor(width, height) {
  if (width < 240 || height < 112) return 'minimal';
  if (width < 330) return 'compact';
  if (height < 126) return 'short';
  return 'comfortable';
}

/**
 * Size each layout is designed around. Used once, on the first measurement, to
 * grow a window whose remembered size predates the current design — not on
 * every density change, which would fight the user's own resizing.
 */
const DENSITY_SIZE = {
  comfortable: { width: 340, height: 132 },
  compact: { width: 300, height: 132 },
  short: { width: 300, height: 126 },
  minimal: { width: 240, height: 104 },
};

/** Latest authoritative state plus the local interpolation anchor. */
let state = {
  hasTrack: false,
  title: null,
  artist: null,
  album: null,
  coverUrl: null,
  isPlaying: false,
  duration: null,
  position: null,
  alwaysOnTop: true,
  canSeek: true,
};

let anchor = { position: 0, at: 0, playing: false };
let density = null;
let fittedSize = false;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function formatTime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** Where the playhead should be right now, given the interpolation anchor. */
function currentPosition() {
  if (typeof anchor.position !== 'number') return null;
  const elapsed = anchor.playing ? (Date.now() - anchor.at) / 1000 : 0;
  const value = anchor.position + Math.max(0, elapsed);
  if (typeof state.duration === 'number' && state.duration > 0) {
    return Math.min(value, state.duration);
  }
  return value;
}

/**
 * Swaps text with a short fade. The new value is written first and then faded
 * in, so there is no await to race against a second track change.
 */
function setText(node, value) {
  if (node.textContent === value) return;
  node.textContent = value;
  if (reduceMotion.matches || !node.animate) return;
  node.animate(
    [
      { opacity: 0, transform: 'translateY(2px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    { duration: 160, easing: 'ease-out' },
  );
}

function renderTrack() {
  const hasTrack = Boolean(state.hasTrack && state.title);
  elements.root.dataset.state = hasTrack ? (state.isPlaying ? 'playing' : 'paused') : 'idle';

  setText(elements.title, hasTrack ? state.title : EMPTY_TITLE);
  elements.title.title = hasTrack ? [state.title, state.artist].filter(Boolean).join(' — ') : '';
  setText(elements.artist, hasTrack ? state.artist || state.album || '' : '');

  if (hasTrack && state.codec) {
    elements.codec.textContent = state.codec;
    elements.codec.hidden = false;
    elements.codec.title = 'Кодек и битрейт текущего потока';
  } else {
    elements.codec.textContent = '';
    elements.codec.hidden = true;
  }

  const cover = state.coverUrl;
  if (cover) {
    if (elements.cover.getAttribute('src') !== cover) elements.cover.setAttribute('src', cover);
    elements.cover.dataset.empty = 'false';
    elements.cover.alt = state.album || state.title || '';
  } else {
    elements.cover.removeAttribute('src');
    elements.cover.dataset.empty = 'true';
  }

  elements.iconPlay.hidden = state.isPlaying;
  elements.iconPause.hidden = !state.isPlaying;
  elements.toggle.title = state.isPlaying ? 'Пауза' : 'Играть';
}

function renderProgress() {
  const position = currentPosition();
  const duration = typeof state.duration === 'number' ? state.duration : null;
  const ratio = duration && duration > 0 && position !== null ? Math.min(1, position / duration) : 0;

  elements.progressFill.style.width = `${(ratio * 100).toFixed(2)}%`;
  elements.progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  elements.elapsed.textContent = formatTime(position);
  elements.duration.textContent = formatTime(duration);
}

/**
 * Grows a window whose remembered size is too small for the layout it lands in.
 *
 * Deliberately once-only, and only on the very first measurement: after that the
 * window belongs to the user. Marking it done even when no growth is needed
 * matters — otherwise a window that started out large would snap itself back
 * every time the user shrank it below the comfortable size. The stylesheet
 * clamps mean a deliberately small window never clips regardless.
 */
function fitToDensity(next) {
  const target = DENSITY_SIZE[next];
  if (!target || fittedSize) return;
  fittedSize = true;
  const { clientWidth, clientHeight } = elements.root;
  if (clientWidth >= target.width && clientHeight >= target.height) return;
  api.requestSize(
    Math.max(clientWidth, target.width),
    Math.max(clientHeight, target.height),
  );
}

function applyDensity() {
  const { clientWidth, clientHeight } = elements.root;
  const next = densityFor(clientWidth, clientHeight);
  if (next !== density) {
    density = next;
    elements.root.dataset.density = next;
  }
  fitToDensity(next);
}

api.on(api.channels.STATE, (payload) => {
  const previousTitle = state.title;
  state = { ...state, ...payload };

  // Re-anchor whenever the reported playhead moves for a reason other than
  // time passing (new track, seek, play/pause).
  const jumped =
    typeof payload.position === 'number' &&
    (Math.abs(payload.position - (currentPosition() ?? payload.position)) > 1.5 ||
      previousTitle !== payload.title ||
      payload.isPlaying !== anchor.playing);

  if (typeof payload.position === 'number' && (jumped || !anchor.at)) {
    anchor = { position: payload.position, at: Date.now(), playing: Boolean(payload.isPlaying) };
  } else {
    anchor.playing = Boolean(payload.isPlaying);
  }

  renderTrack();
  renderProgress();
});

// Smooth local interpolation between the main process polls.
setInterval(renderProgress, 250);

elements.toggle.addEventListener('click', () => api.control({ action: 'toggle' }));
elements.prev.addEventListener('click', () => api.control({ action: 'previous' }));
elements.next.addEventListener('click', () => api.control({ action: 'next' }));
elements.volumeUp.addEventListener('click', () => api.control({ action: 'volumeUp' }));
elements.volumeDown.addEventListener('click', () => api.control({ action: 'volumeDown' }));
elements.pin.addEventListener('click', () => api.control({ action: 'togglePin' }));
elements.close.addEventListener('click', () => api.control({ action: 'hide' }));

elements.progress.addEventListener('click', (event) => {
  const duration = state.duration;
  if (!duration || duration <= 0) return;
  const rect = elements.progress.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  api.control({ action: 'seek', value: ratio * duration });
});

document.addEventListener('keydown', (event) => {
  if (event.key === ' ') {
    event.preventDefault();
    api.control({ action: 'toggle' });
  } else if (event.key === 'Escape') {
    api.control({ action: 'hide' });
  }
});

// The window is resizable, so the layout has to be re-evaluated on every edge
// drag. This replaces the pair of hard-coded media queries the old stylesheet
// used, which could not agree with each other and left `data-compact` dead.
new ResizeObserver(applyDensity).observe(elements.root);

/** Pin state is owned by the main process and echoed back in the state payload. */
api.on(api.channels.TRACK, () => renderTrack());

api.ready();

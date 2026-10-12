/**
 * itirpc test suite.
 *
 * Covers the pure logic that can be verified without launching the client:
 * Discord activity mapping, the IPC wire format, settings merging, and an
 * ASAR write/read round trip. Run with `npm test`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const activity = require(path.join(ROOT, 'src/discord/activity.js'));
const presence = require(path.join(ROOT, 'src/discord/presence.js'));
const { encodeFrame, OPCODE } = require(path.join(ROOT, 'src/discord/ipc.js'));
const { Settings, DEFAULT_SETTINGS } = require(path.join(ROOT, 'src/core/settings.js'));
const pack = await import('./asar-pack.mjs');
const lib = await import('./asar-lib.mjs');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
}

function group(title) {
  process.stdout.write(`\n${title}\n`);
}

function eq(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message} expected ${b}, got ${a}`);
}

function ok(value, message = 'expected truthy') {
  if (!value) throw new Error(message);
}

// ---------------------------------------------------------------------------
group('Discord / toDiscordString');
// ---------------------------------------------------------------------------

check('trims whitespace', () => eq(activity.toDiscordString('  hi  '), 'hi'));
check('empty becomes undefined', () => eq(activity.toDiscordString('   '), undefined));
check('non-string becomes undefined', () => eq(activity.toDiscordString(42), undefined));
check('single char is padded so Discord does not drop it', () =>
  eq(activity.toDiscordString('A'), 'A\u3164'));
check('long strings are cut to the Discord limit', () => {
  const out = activity.toDiscordString('x'.repeat(200));
  eq(out.length, activity.DISCORD_STRING_LIMIT);
});

// ---------------------------------------------------------------------------
group('Discord / language resolution');
// ---------------------------------------------------------------------------

check('explicit ru wins', () => eq(activity.resolveLanguage('ru', 'en-US'), 'ru'));
check('explicit en wins', () => eq(activity.resolveLanguage('en', 'ru-RU'), 'en'));
check('auto follows a Russian locale', () => eq(activity.resolveLanguage('auto', 'ru-RU'), 'ru'));
check('auto defaults to English', () => eq(activity.resolveLanguage('auto', 'de-DE'), 'en'));
check('missing locale defaults to English', () => eq(activity.resolveLanguage('auto', null), 'en'));

// ---------------------------------------------------------------------------
group('Discord / activity building');
// ---------------------------------------------------------------------------

const baseState = {
  hasTrack: true,
  title: 'August 10',
  artist: 'Julie Doiron',
  album: 'Broken Girl',
  coverUrl: 'https://avatars.yandex.net/cover/400x400',
  isPlaying: true,
  duration: 200,
  position: 42,
};

const baseConfig = {
  displayType: 'details',
  language: 'en',
  showButtons: true,
  showTimestamps: true,
  statusDisplayType: 2,
};

check('no track yields no activity', () =>
  eq(activity.buildActivity({ hasTrack: false }, baseConfig, 'en-US'), null));
check('listening type is used', () =>
  eq(activity.buildActivity(baseState, baseConfig, 'en-US').type, 2));
check('details shows the title', () =>
  eq(activity.buildActivity(baseState, baseConfig, 'en-US').details, 'August 10'));
check('details combines artist and album', () =>
  eq(activity.buildActivity(baseState, baseConfig, 'en-US').state, 'Julie Doiron — Broken Girl'));
check('album display type shows the album', () =>
  eq(
    activity.buildActivity(baseState, { ...baseConfig, displayType: 'album' }, 'en-US').state,
    'Broken Girl',
  ));
check('minimal display type omits the second line', () =>
  eq(
    activity.buildActivity(
      { ...baseState, artist: null, album: null },
      { ...baseConfig, displayType: 'minimal' },
      'en-US',
    ).state,
    undefined,
  ));
check('cover becomes the large image', () =>
  eq(
    activity.buildActivity(baseState, baseConfig, 'en-US').assets.large_image,
    'https://avatars.yandex.net/cover/400x400',
  ));
check('large_text is not sent', () => {
  // The client reports `album` as the track title for many tracks, so this line
  // printed the words above a second time.
  eq(activity.buildActivity(baseState, baseConfig, 'en-US').assets.large_text, undefined);
});
check('small image is omitted unless an asset key is configured', () =>
  eq(activity.buildActivity(baseState, baseConfig, 'en-US').assets.small_image, undefined));
check('small image is used when configured', () =>
  eq(
    activity.buildActivity(baseState, { ...baseConfig, smallImageKey: 'playing' }, 'en-US').assets
      .small_image,
    'playing',
  ));
check('playing with a duration produces timestamps', () => {
  const a = activity.buildActivity(baseState, baseConfig, 'en-US');
  ok(a.timestamps && a.timestamps.end - a.timestamps.start === 200_000, 'duration must be 200s');
});
check('timestamps are anchored to the real playhead', () => {
  const before = Date.now();
  const a = activity.buildActivity(baseState, baseConfig, 'en-US');
  const start = a.timestamps.start;
  ok(Math.abs(start - (before - 42_000)) < 2000, `start ${start} should be ~now-42s`);
});
check('paused playback drops timestamps', () =>
  eq(
    activity.buildActivity({ ...baseState, isPlaying: false }, baseConfig, 'en-US').timestamps,
    undefined,
  ));
check('paused playback says so on the second line', () => {
  const a = activity.buildActivity({ ...baseState, isPlaying: false }, baseConfig, 'en-US');
  ok(a.state.includes('Paused'), `expected a paused word, got ${JSON.stringify(a.state)}`);
});
check('the paused word follows the language setting', () => {
  const ru = activity.buildActivity({ ...baseState, isPlaying: false }, { ...baseConfig, language: 'ru' }, 'en-US');
  ok(ru.state.includes('\u041d\u0430 \u043f\u0430\u0443\u0437\u0435'), `got ${JSON.stringify(ru.state)}`);
});
check('the paused word survives every display type', () => {
  for (const displayType of ['details', 'album', 'minimal']) {
    const a = activity.buildActivity(
      { ...baseState, isPlaying: false },
      { ...baseConfig, displayType },
      'en-US',
    );
    ok(a.state?.includes('Paused'), `${displayType} must still report the pause`);
  }
});
check('zero duration drops timestamps', () =>
  eq(
    activity.buildActivity({ ...baseState, duration: 0 }, baseConfig, 'en-US').timestamps,
    undefined,
  ));
check('timestamps can be disabled', () =>
  eq(
    activity.buildActivity(baseState, { ...baseConfig, showTimestamps: false }, 'en-US').timestamps,
    undefined,
  ));
check('buttons carry a Yandex Music search link', () => {
  const a = activity.buildActivity(baseState, baseConfig, 'en-US');
  eq(a.buttons.length, 1);
  ok(a.buttons[0].url.startsWith('https://music.yandex.ru/search?text='), 'search url');
  ok(a.buttons[0].url.includes('August%2010'), 'title must be encoded');
});
check('buttons can be disabled', () =>
  eq(activity.buildActivity(baseState, { ...baseConfig, showButtons: false }, 'en-US').buttons, undefined));
check('missing artwork omits assets entirely', () =>
  eq(
    activity.buildActivity({ ...baseState, coverUrl: null }, baseConfig, 'en-US').assets,
    undefined,
  ));
check('status_display_type is forwarded', () =>
  eq(activity.buildActivity(baseState, baseConfig, 'en-US').status_display_type, 2));
check('status_display_type can be omitted', () =>
  eq(
    activity.buildActivity(baseState, { ...baseConfig, statusDisplayType: null }, 'en-US')
      .status_display_type,
    undefined,
  ));
check('title-only playback still produces an activity', () => {
  const a = activity.buildActivity(
    { hasTrack: true, title: 'Solo', artist: null, album: null, isPlaying: true },
    baseConfig,
    'en-US',
  );
  eq(a.details, 'Solo');
  eq(a.state, undefined);
});

// ---------------------------------------------------------------------------
group('Discord / fallback and equality');
// ---------------------------------------------------------------------------

check('stripOptionalFields removes newer fields only', () => {
  const full = activity.buildActivity(baseState, baseConfig, 'en-US');
  const stripped = activity.stripOptionalFields(full);
  eq(stripped.status_display_type, undefined);
  eq(stripped.buttons, undefined);
  eq(stripped.details, 'August 10');
  ok(stripped.timestamps, 'timestamps must survive');
});
check('a different album cover compares unequal', () => {
  const a = activity.buildActivity(baseState, baseConfig, 'en-US');
  const b = activity.buildActivity(
    { ...baseState, coverUrl: 'https://other/cover' },
    baseConfig,
    'en-US',
  );
  ok(!activity.activitiesEqual(a, b));
});
check('timestamp jitter alone does not count as a change', () => {
  // Comparing timestamps exactly made every poll look different, so Discord was
  // re-sent every four seconds instead of only on real changes.
  const a = activity.buildActivity(baseState, baseConfig, 'en-US');
  const b = { ...a, timestamps: { start: a.timestamps.start + 7, end: a.timestamps.end + 7 } };
  ok(activity.activitiesEqual(a, b), 'a few milliseconds of drift is not a change');
});
check('gaining or losing the progress bar counts as a change', () => {
  // The absence of the progress bar is the pause signal, so it must not be
  // filtered out as "invisible" — doing so delayed every pause by up to a full
  // heartbeat interval.
  const playing = activity.buildActivity(baseState, baseConfig, 'en-US');
  const paused = activity.buildActivity({ ...baseState, isPlaying: false }, baseConfig, 'en-US');
  ok(!activity.activitiesEqual(playing, paused), 'pause must force a re-send');
  ok(!activity.activitiesEqual(paused, playing), 'resume must force a re-send');
});
check('a small_text change counts as a change', () => {
  const a = activity.buildActivity(baseState, { ...baseConfig, smallImageKey: 'icon' }, 'en-US');
  const b = activity.buildActivity({ ...baseState, isPlaying: false }, { ...baseConfig, smallImageKey: 'icon' }, 'en-US');
  ok(!activity.activitiesEqual(a, b));
});
check('identical activities compare equal', () => {
  const a = activity.buildActivity(baseState, baseConfig, 'en-US');
  const b = activity.buildActivity(baseState, baseConfig, 'en-US');
  b.timestamps = a.timestamps;
  ok(activity.activitiesEqual(a, b));
});
check('different titles compare unequal', () => {
  const a = activity.buildActivity(baseState, baseConfig, 'en-US');
  const b = activity.buildActivity({ ...baseState, title: 'Other' }, baseConfig, 'en-US');
  ok(!activity.activitiesEqual(a, b));
});
check('null compares unequal to an activity', () =>
  ok(!activity.activitiesEqual(null, { details: 'x' })));

// ---------------------------------------------------------------------------
group('Discord / presence send policy');
// ---------------------------------------------------------------------------

const playing = activity.buildActivity(baseState, baseConfig, 'en-US');
const paused = activity.buildActivity({ ...baseState, isPlaying: false }, baseConfig, 'en-US');
const T0 = 1_700_000_000_000;

check('an unchanged activity is not re-sent before the throttle elapses', () => {
  eq(presence.sendReason(playing, playing, T0, T0 + 1000), null);
});
check('an unchanged activity is not re-sent after the throttle either', () => {
  eq(presence.sendReason(playing, playing, T0, T0 + 5000), null);
});
check('an unchanged activity is re-sent once the heartbeat is due', () => {
  eq(presence.sendReason(playing, playing, T0, T0 + presence.HEARTBEAT_MS), 'heartbeat');
});
check('a track change is sent as soon as the throttle allows', () => {
  const other = activity.buildActivity({ ...baseState, title: 'Other' }, baseConfig, 'en-US');
  eq(presence.sendReason(other, playing, T0, T0 + presence.MIN_SEND_INTERVAL_MS), 'change');
});
check('pausing is detected as a change, not as a heartbeat', () => {
  // This is the regression: the pause used to look identical to the activity
  // already on screen, so nothing was sent until the 30s heartbeat fired.
  eq(presence.sendReason(paused, playing, T0, T0 + presence.MIN_SEND_INTERVAL_MS), 'change');
});
check('resuming is detected as a change', () => {
  eq(presence.sendReason(playing, paused, T0, T0 + presence.MIN_SEND_INTERVAL_MS), 'change');
});
check('a pause survives a full heartbeat cycle', () => {
  eq(presence.sendReason(paused, playing, T0, T0 + presence.HEARTBEAT_MS), 'change');
});
check('losing the progress bar counts as drift on its own', () => {
  const stripped = { ...playing, timestamps: undefined };
  eq(presence.timestampsDrifted(playing, stripped), true);
  eq(presence.timestampsDrifted(stripped, playing), true);
  eq(presence.timestampsDrifted(stripped, stripped), false);
});
check('timestamp jitter is not drift', () => {
  const jittered = { ...playing, timestamps: { ...playing.timestamps, start: playing.timestamps.start + 7 } };
  eq(presence.timestampsDrifted(playing, jittered), false);
});
check('a re-anchored progress bar is drift', () => {
  const seeked = { ...playing, timestamps: { ...playing.timestamps, start: playing.timestamps.start + 60_000 } };
  eq(presence.timestampsDrifted(playing, seeked), true);
});
check('a forced transition ignores the normal throttle', () => {
  // The user pressed pause half a second after the last update; waiting out the
  // full three second throttle is exactly the lag this is meant to remove.
  const now = T0 + presence.TRANSITION_SEND_INTERVAL_MS + 100;
  eq(presence.sendReason(paused, playing, T0, now), null);
  eq(presence.sendReason(paused, playing, T0, now, true), 'change');
});
check('a forced transition still respects the rate limit', () => {
  eq(presence.sendReason(paused, playing, T0, T0 + 200, true), null);
  eq(presence.sendReason(paused, playing, T0, T0 + 200, true), null);
  eq(presence.sendReason(paused, playing, T0, T0 + presence.TRANSITION_SEND_INTERVAL_MS, true), 'change');
});
check('nothing to send is never sent', () => {
  eq(presence.sendReason(null, playing, T0, T0 + 60_000), null);
});
check('a cleared presence is re-sent from scratch', () => {
  eq(presence.sendReason(playing, null, 0, T0), 'change');
});

// ---------------------------------------------------------------------------
group('Discord / IPC wire format');
// ---------------------------------------------------------------------------

check('frame header is little-endian opcode + length', () => {
  const frame = encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: 'abc' });
  eq(frame.readUInt32LE(0), 0);
  const body = frame.subarray(8).toString('utf8');
  eq(frame.readUInt32LE(4), Buffer.byteLength(body));
  eq(JSON.parse(body), { v: 1, client_id: 'abc' });
});
check('frame length matches the payload exactly', () => {
  const payload = { cmd: 'SET_ACTIVITY', args: { pid: 1, activity: { details: 'тест' } } };
  const frame = encodeFrame(OPCODE.FRAME, payload);
  eq(frame.length, 8 + Buffer.byteLength(JSON.stringify(payload), 'utf8'));
});

// ---------------------------------------------------------------------------
group('Settings');
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itirpc-test-'));
const settingsPath = path.join(tmpDir, 'config.json');

check('config file is created on first run', () => {
  new Settings(settingsPath);
  ok(fs.existsSync(settingsPath), 'config.json should exist after construction');
});
check('defaults are complete', () => {
  const s = new Settings(settingsPath);
  eq(s.get('discord.displayType'), DEFAULT_SETTINGS.discord.displayType);
  eq(s.get('hotkeys.playPause'), DEFAULT_SETTINGS.hotkeys.playPause);
});
check('user values override defaults', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ discord: { clientId: '123', language: 'ru' } }));
  const s = new Settings(settingsPath);
  eq(s.get('discord.clientId'), '123');
  eq(s.get('discord.language'), 'ru');
  eq(s.get('discord.displayType'), 'details', 'untouched keys keep defaults');
});
check('unknown keys are preserved', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ myOwn: { flag: true } }));
  const s = new Settings(settingsPath);
  eq(s.get('myOwn.flag'), true);
});
check('set persists to disk', () => {
  const s = new Settings(settingsPath);
  s.set('discord.clientId', '999');
  const reread = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  eq(reread.discord.clientId, '999');
});
check('partial nested objects keep sibling defaults', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ discord: { enabled: false } }));
  const s = new Settings(settingsPath);
  eq(s.get('discord.enabled'), false);
  eq(s.get('discord.idleTimeoutMinutes'), DEFAULT_SETTINGS.discord.idleTimeoutMinutes);
  s.dispose();
});
check('dispose stops watching and is idempotent', () => {
  const s = new Settings(settingsPath);
  s.dispose();
  s.dispose();
  eq(s.watching, false);
});

// Deleting the watched file makes fs.watch emit an asynchronous 'error' event.
// Without a handler that becomes an unhandled exception and kills the client,
// so this runs the real sequence and then asserts the process is still healthy.
{
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itirpc-watch-'));
  const watchedFile = path.join(watchDir, 'config.json');
  const watched = new Settings(watchedFile);
  const wasWatching = watched.watching;
  fs.rmSync(watchDir, { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, 200));

  check('a watched file being deleted does not crash', () => {
    ok(wasWatching, 'should have been watching after construction');
    eq(watched.watching, false, 'the watcher must give up instead of throwing');
  });
  watched.dispose();
}
check('setting an unchanged value writes nothing', () => {
  fs.writeFileSync(settingsPath, JSON.stringify({ discord: { clientId: 'abc' } }));
  const s = new Settings(settingsPath);
  const before = fs.statSync(settingsPath).mtimeMs;
  const changed = s.set('discord.clientId', 'abc');
  eq(changed, false, 'set() must report no change');
  eq(fs.statSync(settingsPath).mtimeMs, before, 'file must not be rewritten');
});
check('changing a value reports true', () => {
  const s = new Settings(settingsPath);
  eq(s.set('discord.clientId', 'xyz'), true);
});
check('setting the same value twice is idempotent', () => {
  const s = new Settings(settingsPath);
  s.set('ui.trayIcon', false);
  eq(s.set('ui.trayIcon', false), false);
});

// ---------------------------------------------------------------------------
group('Hotkeys');
// ---------------------------------------------------------------------------

const { pickAccelerators, isDisabled } = require(path.join(ROOT, 'src/core/hotkey-definitions.js'));

check('empty, "none" and non-strings count as disabled', () => {
  ok(isDisabled(''), 'empty string');
  ok(isDisabled('   '), 'whitespace');
  ok(isDisabled('none'), 'none');
  ok(isDisabled(undefined), 'undefined');
  ok(!isDisabled('Control+/'), 'a real accelerator is enabled');
});
check('the accelerator signature ignores unrelated settings', () => {
  const base = { ...DEFAULT_SETTINGS.hotkeys };
  const withNoise = { ...base, someFutureKey: 'Control+Q' };
  eq(JSON.stringify(pickAccelerators(withNoise)), JSON.stringify(pickAccelerators(base)));
});
check('the accelerator signature tracks real changes', () => {
  const base = { ...DEFAULT_SETTINGS.hotkeys };
  const changed = { ...base, next: 'Control+Shift+N' };
  ok(JSON.stringify(pickAccelerators(changed)) !== JSON.stringify(pickAccelerators(base)));
});
check('the default mini player shortcut avoids Discord mute', () => {
  // Ctrl+Shift+M is Discord's own mute shortcut, so it is never registrable.
  ok(DEFAULT_SETTINGS.hotkeys.miniPlayer !== 'Control+Shift+M');
});
check('zoom shortcuts are part of the accelerator signature', () => {
  const base = { ...DEFAULT_SETTINGS.hotkeys };
  const changed = { ...base, zoomIn: 'Control+Shift+=' };
  ok(JSON.stringify(pickAccelerators(changed)) !== JSON.stringify(pickAccelerators(base)));
  ok('zoomIn' in pickAccelerators(base), 'zoomIn must be tracked');
  ok('zoomReset' in pickAccelerators(base), 'zoomReset must be tracked');
});

// ---------------------------------------------------------------------------
group('ASAR writer');
// ---------------------------------------------------------------------------

const asarDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itirpc-asar-'));
// Outputs go to a sibling directory: writing archives next to their own sources
// would make each pack pick up the previous archive as an input file.
const asarOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itirpc-asarout-'));
fs.mkdirSync(path.join(asarDir, 'nested', 'deep'), { recursive: true });
fs.writeFileSync(path.join(asarDir, 'root.txt'), 'hello');
fs.writeFileSync(path.join(asarDir, 'nested', 'deep', 'inner.js'), 'module.exports = 42;');
const asarOut = path.join(asarOutDir, 'out.asar');

check('pack then read returns identical content', () => {
  pack.packAsar(asarDir, asarOut);
  const { header, baseOffset } = lib.readAsarHeader(asarOut);
  const entries = lib.walkAsarEntries(header);
  eq(entries.map((e) => e.path).sort(), ['nested/deep/inner.js', 'root.txt']);
  eq(lib.readAsarFile(asarOut, header, baseOffset, 'root.txt').toString('utf8'), 'hello');
  eq(
    lib.readAsarFile(asarOut, header, baseOffset, 'nested/deep/inner.js').toString('utf8'),
    'module.exports = 42;',
  );
});
check('offsets are contiguous and monotonic', () => {
  const { header } = lib.readAsarHeader(asarOut);
  const entries = lib.walkAsarEntries(header);
  let expected = 0;
  for (const entry of entries) {
    eq(entry.offset, expected, `offset of ${entry.path}`);
    expected += entry.size;
  }
});
check('integrity hashes are written and correct', () => {
  const { header } = lib.readAsarHeader(asarOut);
  const entry = lib.walkAsarEntries(header).find((e) => e.path === 'root.txt');
  ok(entry.hash, 'hash must be present');
  eq(entry.blockSize, 4 * 1024 * 1024);
  ok(Array.isArray(entry.hash) === false);
});
check('overlay directories override base files', () => {
  const overlayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itirpc-overlay-'));
  fs.writeFileSync(path.join(overlayDir, 'root.txt'), 'overridden');
  fs.writeFileSync(path.join(overlayDir, 'added.txt'), 'new');
  const out2 = path.join(asarOutDir, 'out2.asar');
  pack.packAsar(asarDir, out2, { overlays: [overlayDir] });
  const { header, baseOffset } = lib.readAsarHeader(out2);
  eq(lib.readAsarFile(out2, header, baseOffset, 'root.txt').toString('utf8'), 'overridden');
  eq(lib.readAsarFile(out2, header, baseOffset, 'added.txt').toString('utf8'), 'new');
});
check('template ordering is preserved', () => {
  const out3 = path.join(asarOutDir, 'out3.asar');
  pack.packAsar(asarDir, out3, { templateAsar: asarOut });
  const a = lib.walkAsarEntries(lib.readAsarHeader(asarOut).header).map((e) => e.path);
  const b = lib.walkAsarEntries(lib.readAsarHeader(out3).header).map((e) => e.path);
  eq(b, a, 'entry order must follow the template');
});

// ---------------------------------------------------------------------------
group('Zoom');
// ---------------------------------------------------------------------------

const { ZoomController, clampFactor, MIN_FACTOR, MAX_FACTOR, STEP } = require(
  path.join(ROOT, 'src/core/zoom.js'),
);

/** Stands in for a webContents: records zoom calls and navigation listeners. */
function fakeRenderer() {
  const handlers = new Map();
  return {
    applied: [],
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    setZoomFactor(factor) {
      if (this.destroyed) throw new Error('destroyed');
      this.applied.push(factor);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    removeListener(event, handler) {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
    listeners(event) {
      return (handlers.get(event) ?? []).length;
    },
    navigate() {
      for (const handler of handlers.get('did-finish-load') ?? []) handler();
    },
  };
}

function fakeZoom() {
  const listeners = [];
  const settings = {
    value: 1,
    get: (key) => (key === 'ui.zoom' ? settings.value : undefined),
    set: (key, value) => {
      if (key === 'ui.zoom') settings.value = value;
    },
    onChange: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
  };
  const logger = { error() {}, warn() {}, info() {}, debug() {} };
  return { zoom: new ZoomController({ settings, logger }), settings, logger };
}

check('factor is clamped to the supported range', () => {
  eq(clampFactor(0.1), MIN_FACTOR);
  eq(clampFactor(10), MAX_FACTOR);
  eq(clampFactor(1), 1);
});
check('clamping removes floating point noise', () => {
  // 1.1 ** 8 would otherwise accumulate into 2.1435888100000003.
  eq(clampFactor(1.1 * 1.1 * 1.1), 1.331);
});
check('the default step stays inside the range', () => {
  eq(clampFactor(STEP), 1.1);
  eq(clampFactor(1 / STEP), 0.909);
});
check('the stored default zoom is 100%', () => {
  eq(DEFAULT_SETTINGS.ui.zoom, 1);
});
check('zoom hotkeys use the browser conventions', () => {
  eq(DEFAULT_SETTINGS.hotkeys.zoomIn, 'Control+=');
  eq(DEFAULT_SETTINGS.hotkeys.zoomOut, 'Control+-');
  eq(DEFAULT_SETTINGS.hotkeys.zoomReset, 'Control+0');
});

check('one controller drives both renderers', () => {
  // The mini player has its own webContents; the client window used to be the
  // only target, so the mini player ignored the zoom factor entirely.
  const client = fakeRenderer();
  const mini = fakeRenderer();
  const { zoom, settings } = fakeZoom();

  zoom.attach(client);
  zoom.attach(mini);
  eq(client.applied.at(-1), 1);
  eq(mini.applied.at(-1), 1);

  zoom.set(1.5);
  eq(client.applied.at(-1), 1.5);
  eq(mini.applied.at(-1), 1.5);
  eq(settings.value, 1.5);
});

check('detaching one renderer leaves the other bound', () => {
  const client = fakeRenderer();
  const mini = fakeRenderer();
  const { zoom } = fakeZoom();
  zoom.attach(client);
  zoom.attach(mini);

  zoom.detach(mini);
  zoom.set(2);
  eq(client.applied.at(-1), 2);
  eq(mini.applied.at(-1), 1, 'a detached renderer must not be touched again');
});

check('attaching the same renderer twice registers nothing extra', () => {
  const mini = fakeRenderer();
  const { zoom } = fakeZoom();
  zoom.attach(mini);
  zoom.attach(mini);
  eq(mini.listeners('did-finish-load'), 1);
});

check('a settings change applies without a shortcut', () => {
  // Regression: the slider in the settings window wrote ui.zoom but nothing
  // listened, so it only took effect after the next Ctrl+=.
  const mini = fakeRenderer();
  const { zoom, settings } = fakeZoom();
  zoom.attach(mini);
  zoom.watch();

  settings.value = 1.25;
  settings.emit();
  eq(mini.applied.at(-1), 1.25);
});

check('a destroyed renderer is pruned instead of throwing', () => {
  const mini = fakeRenderer();
  const { zoom } = fakeZoom();
  zoom.attach(mini);
  mini.destroyed = true;
  eq(zoom.apply(), 0);
  eq(zoom.targets.size, 0);
});

check('dispose unbinds every renderer and stops watching', () => {
  const client = fakeRenderer();
  const mini = fakeRenderer();
  const { zoom, settings } = fakeZoom();
  zoom.attach(client);
  zoom.attach(mini);
  zoom.watch();
  zoom.dispose();

  settings.value = 3;
  settings.emit();
  eq(client.applied.at(-1), 1);
  eq(mini.applied.at(-1), 1);
  eq(client.listeners('did-finish-load'), 0);
});

// ---------------------------------------------------------------------------
group('Stream description');
// ---------------------------------------------------------------------------

const { describeStream } = require(path.join(ROOT, 'src/player/player-monitor.js'));

check('AAC stream is recognised', () => {
  const s = describeStream('https://strm.yandex.net/aac/128/track/12345');
  eq(s.codec, 'AAC');
});
check('MP3 stream is recognised', () => {
  eq(describeStream('https://strm.yandex.net/mp3/track/1.mp3').codec, 'MP3');
});
check('bitrate is read from the path', () => {
  eq(describeStream('https://strm.yandex.net/aac/320/track/1').bitrateKbps, 320);
});
check('an implausible number is not treated as a bitrate', () => {
  // A track id must not be mistaken for 1411 kbps, and 5 is below any codec.
  eq(describeStream('https://strm.yandex.net/mp3/track/5').bitrateKbps, null);
});
check('an unknown codec is reported as unknown, not guessed', () => {
  const s = describeStream('https://example.com/stream/xyz');
  eq(s.codec, null);
  eq(s.bitrateKbps, null);
  ok(s.url, 'the url is still reported');
});
check('an empty source yields nothing', () => {
  eq(describeStream('').codec, null);
  eq(describeStream(null).url, null);
  eq(describeStream(undefined).url, null);
});

// ---------------------------------------------------------------------------
group('Downloads');
// ---------------------------------------------------------------------------

const dl = require(path.join(ROOT, 'src/downloads/downloader.js'));
const { createNodeTransport } = require(path.join(ROOT, 'src/downloads/transport.js'));

check('illegal windows characters are replaced', () => {
  eq(dl.sanitizeFileName('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
});
check('control characters are replaced', () => {
  eq(dl.sanitizeFileName('a\u0000b\u001fc'), 'a_b_c');
});
check('trailing dots and spaces are stripped', () => {
  // Windows silently drops these, which would desync the reported path.
  eq(dl.sanitizeFileName('track...  '), 'track');
});
check('reserved device names are escaped', () => {
  eq(dl.sanitizeFileName('CON'), '_CON');
  eq(dl.sanitizeFileName('lpt1'), '_lpt1');
  ok(!dl.sanitizeFileName('console').startsWith('_'), 'only exact matches are reserved');
});
check('empty input falls back', () => {
  eq(dl.sanitizeFileName('', 'track'), 'track');
  eq(dl.sanitizeFileName(null, 'track'), 'track');
  eq(dl.sanitizeFileName('   '), 'track');
});
check('long names are truncated', () => {
  const out = dl.sanitizeFileName('x'.repeat(500));
  eq(out.length, dl.MAX_BASE_LENGTH);
});
check('file name is "Artist - Title.ext"', () => {
  eq(dl.buildFileName({ artist: 'Julie Doiron', title: 'August 10' }, '.m4a'), 'Julie Doiron - August 10.m4a');
});
check('file name degrades without an artist', () => {
  eq(dl.buildFileName({ title: 'Solo' }, '.mp3'), 'Solo.mp3');
  eq(dl.buildFileName({}, '.mp3'), 'track.mp3');
});
check('extension comes from the url when possible', () => {
  eq(dl.extensionFor('https://x/a/track.mp3?token=1', 'application/octet-stream'), '.mp3');
  eq(dl.extensionFor('https://x/a/track.m4a', undefined), '.m4a');
});
check('extension falls back to the content type', () => {
  eq(dl.extensionFor('https://x/stream', 'audio/mpeg'), '.mp3');
  eq(dl.extensionFor('https://x/stream', 'audio/mp4'), '.m4a');
  eq(dl.extensionFor('https://x/stream', 'audio/flac'), '.flac');
  eq(dl.extensionFor('https://x/stream', undefined), '.bin');
});
check('the real container token yields .m4a, not .bin', () => {
  // Observed live: the CDN returned no content-type at all and the path ends in
  // `-mp4`, so a suffix check alone saved a valid AAC track as `.bin`.
  eq(
    dl.extensionFor(
      'https://strm-mar-238.strm.yandex.net/music-v2/crypt/ysign1=abc/0/1529911/x/aac192-mp4?container=mp4&codec=mp4a.40.2',
      undefined,
    ),
    '.m4a',
  );
  eq(dl.extensionFor('https://x/y/mp3_320-mp3?a=1', undefined), '.mp3');
  eq(dl.extensionFor('https://x/y/flac1411-flac', undefined), '.flac');
});
check('a bare codec token still yields a sensible extension', () => {
  eq(dl.extensionFor('https://x/y/aac192-file', undefined), '.m4a');
  eq(dl.extensionFor('https://x/y/mp3-file', undefined), '.mp3');
});

// A real download against a local server, using the same code path the client
// uses minus the Electron session. The operations run first and their results
// are asserted synchronously afterwards, because `check` is synchronous.
const payload = Buffer.alloc(256 * 1024, 7);
const server = http.createServer((req, res) => {
  if (req.url === '/audio/track.mp3') {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': payload.length });
    res.end(payload);
  } else if (req.url === '/redirect') {
    res.writeHead(302, { location: '/audio/track.mp3' });
    res.end();
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itirpc-dl-'));

function makeDownloader(overrides = {}) {
  // Downloader reads the whole `downloads` section, not a dotted key. The
  // feature is off by default, so tests opt in explicitly.
  const downloadsConfig = {
    enabled: true,
    directory: downloadDir,
    convertToMp3: false,
    ffmpegPath: '',
    ...overrides,
  };
  return new dl.Downloader({
    settings: { get: (key) => (key === 'downloads' ? downloadsConfig : undefined) },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    transport: createNodeTransport(),
  });
}

/** A downloader built exactly like production, with the feature left off. */
function makeDisabledDownloader() {
  return new dl.Downloader({
    settings: { get: () => ({ enabled: false, directory: downloadDir }) },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    transport: createNodeTransport(),
  });
}

const trackUrl = `http://127.0.0.1:${port}/audio/track.mp3`;
const first = await makeDownloader().download({ artist: 'Test Artist', title: 'Test Track' }, trackUrl);
const second = await makeDownloader().download({ artist: 'Test Artist', title: 'Test Track' }, trackUrl);
const third = await makeDownloader().download({ title: 'Redirected' }, `http://127.0.0.1:${port}/redirect`);
const missing = await makeDownloader().download({ title: 'Missing' }, `http://127.0.0.1:${port}/nope`);
const noUrl = await makeDownloader().download({ title: 'x' }, null);

const progressEvents = [];
const progressDownloader = makeDownloader();
progressDownloader.on('progress', (status) => progressEvents.push(status));
await progressDownloader.download({ title: 'Progress' }, trackUrl);

const busyDownloader = makeDownloader();
busyDownloader.active = { track: {}, received: 0, total: 0, targetPath: 'x' };
const busy = await busyDownloader.download({ title: 'Busy' }, trackUrl);

const noTransport = new dl.Downloader({
  settings: { get: () => ({ enabled: true, directory: downloadDir }) },
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  transport: null,
});
const withoutTransport = await noTransport.download({ title: 'x' }, trackUrl);

// The feature ships disabled, so the refusal itself has to be verified.
const disabled = await makeDisabledDownloader().download({ title: 'x' }, trackUrl);

server.close();

check('a real download writes the file with the full payload', () => {
  ok(first.ok, `download failed: ${first.error}`);
  eq(first.bytes, payload.length);
  ok(fs.existsSync(first.path), 'file must exist');
  eq(fs.readFileSync(first.path).length, payload.length);
});
check('the file is named from the track metadata', () => {
  eq(path.basename(first.path), 'Test Artist - Test Track.mp3');
});
check('no .part file is left behind', () => {
  const leftovers = fs.readdirSync(downloadDir).filter((f) => f.endsWith('.part'));
  eq(leftovers, []);
});
check('a second download gets a distinct name', () => {
  ok(second.ok, `second download failed: ${second.error}`);
  eq(path.basename(second.path), 'Test Artist - Test Track (2).mp3');
});
check('a redirect target is downloaded', () => {
  ok(third.ok, `download failed: ${third.error}`);
  eq(third.bytes, payload.length);
});
check('a non-200 response is reported as an error', () => {
  ok(!missing.ok);
  ok(missing.error.includes('404'), `error should mention 404: ${missing.error}`);
});
check('a missing stream url is a clear error', () => {
  ok(!noUrl.ok);
  ok(/ссылк|поток/.test(noUrl.error), noUrl.error);
});
check('progress events carry received bytes and a percentage', () => {
  ok(progressEvents.length > 0, 'at least one progress event');
  const last = progressEvents[progressEvents.length - 1];
  eq(last.total, payload.length);
  eq(last.percent, 100);
});
check('a concurrent download is refused', () => {
  ok(!busy.ok);
  ok(busy.error.includes('уже идёт'), busy.error);
});
check('a downloader without a transport reports it', () => {
  ok(!withoutTransport.ok);
  ok(withoutTransport.error.includes('транспорт'), withoutTransport.error);
});
check('downloads are refused while disabled, explaining why', () => {
  ok(!disabled.ok, 'must refuse');
  ok(disabled.error.includes('отключено'), disabled.error);
  ok(disabled.error.includes('зашифрован'), `error must state the reason: ${disabled.error}`);
});
check('the default configuration ships downloads disabled', () => {
  eq(DEFAULT_SETTINGS.downloads.enabled, false);
});

// ---------------------------------------------------------------------------
group('Stream description');
// ---------------------------------------------------------------------------

// Captured verbatim from the live client (5.122.0).
const REAL_STREAM_URL =
  'https://strm-mar-135.strm.yandex.net/music-v2/crypt/ysign1=2f2417b53c43ee1c4f6be171ce8dd957796c62c1095a75b1d9ef88d364a0073a,kts=6e41f1c9,lid=83,pfx,secret_version=ver-1,sfx,source=mds,ts=6ad147c9/0/50334/376aa390.218580340.3.150103080/aac192-mp4?container=mp4&codec=mp4a.40.2&vsid=6he3ajd9m2lvve9brojfdvvto2bth47aes4mtba9gyt5xMWEx0001x1791190032&source_index=2#t=0';

check('the real URL yields AAC', () => {
  eq(describeStream(REAL_STREAM_URL).codec, 'AAC');
});
check('the real URL yields 192 kbps, not the server number', () => {
  // `strm-mar-135` is a hostname: 135 is a shard index, not a bitrate. The real
  // value sits in the `aac192` path token. This was a live bug.
  eq(describeStream(REAL_STREAM_URL).bitrateKbps, 192);
});
check('a bare number in the host is never read as a bitrate', () => {
  eq(describeStream('https://strm-mar-135.strm.yandex.net/stream/abc').bitrateKbps, null);
  eq(describeStream('https://strm-mar-320.strm.yandex.net/x/y').bitrateKbps, null);
});
check('an explicit codec parameter is used when the path has no token', () => {
  eq(describeStream('https://x/y/z?container=mp4&codec=mp4a.40.2').codec, 'AAC');
  eq(describeStream('https://x/y/z?codec=opus').codec, 'Opus');
});
check('an explicit bitrate parameter is honoured', () => {
  eq(describeStream('https://x/y?bitrate=320').bitrateKbps, 320);
  eq(describeStream('https://x/y?abr=256').bitrateKbps, 256);
  eq(describeStream('https://x/y/192kbps/file').bitrateKbps, 192);
});
check('mp3 and flac path tokens carry their bitrate', () => {
  eq(describeStream('https://x/mp3_320-track').codec, 'MP3');
  eq(describeStream('https://x/mp3_320-track').bitrateKbps, 320);
  eq(describeStream('https://x/flac1411-track').codec, 'FLAC');
  eq(describeStream('https://x/flac1411-track').bitrateKbps, 1411);
});

// ---------------------------------------------------------------------------
group('Last.fm');
// ---------------------------------------------------------------------------

const lastfm = require(path.join(ROOT, 'src/lastfm/api.js'));

check('tracks under 30s never scrobble', () => {
  eq(lastfm.scrobbleThresholdSeconds(20), null);
  ok(!lastfm.isEligibleForScrobble(20, 20), 'a short track must not count');
  ok(!lastfm.isEligibleForScrobble(29, 29), 'just under the limit must not count');
});
check('threshold is half the track', () => {
  eq(lastfm.scrobbleThresholdSeconds(200), 100);
  eq(lastfm.scrobbleThresholdSeconds(60), 30);
});
check('threshold is capped at four minutes', () => {
  // A 30 minute track must not require 15 minutes of listening.
  eq(lastfm.scrobbleThresholdSeconds(1800), 240);
});
check('exactly half counts as played', () => {
  ok(lastfm.isEligibleForScrobble(200, 100), '50% must be enough');
});
check('just under half does not count', () => {
  ok(!lastfm.isEligibleForScrobble(200, 99.9));
});
check('long tracks count at four minutes', () => {
  ok(lastfm.isEligibleForScrobble(1800, 240));
  ok(!lastfm.isEligibleForScrobble(1800, 239));
});
check('unknown duration never counts', () => {
  ok(!lastfm.isEligibleForScrobble(null, 500));
  ok(!lastfm.isEligibleForScrobble(0, 500));
});
check('signature is deterministic and key-order independent', () => {
  const a = lastfm.signParams({ b: '2', a: '1' }, 'secret');
  const b = lastfm.signParams({ a: '1', b: '2' }, 'secret');
  eq(a, b);
  eq(a.length, 32, 'md5 hex');
});
check('signature changes with the secret', () => {
  ok(lastfm.signParams({ a: '1' }, 'one') !== lastfm.signParams({ a: '1' }, 'two'));
});
check('signature ignores format and callback', () => {
  const withNoise = lastfm.signParams({ a: '1', format: 'json', callback: 'x' }, 's');
  eq(withNoise, lastfm.signParams({ a: '1' }, 's'));
});
check('signature matches the documented construction', () => {
  // md5("a1b2" + secret), computed independently of the implementation.
  const expected = crypto.createHash('md5').update('a1b2' + 'sec', 'utf8').digest('hex');
  eq(lastfm.signParams({ b: '2', a: '1' }, 'sec'), expected);
});
check('an unconfigured api reports itself as such', () => {
  ok(!new lastfm.LastFmApi({ apiKey: '', sharedSecret: '' }).configured);
  ok(new lastfm.LastFmApi({ apiKey: 'k', sharedSecret: 's' }).configured);
});
check('authorization url carries the key and token', () => {
  const api = new lastfm.LastFmApi({ apiKey: 'KEY', sharedSecret: 's' });
  const url = api.authorizationUrl('TOK');
  ok(url.startsWith('https://www.last.fm/api/auth/'), 'must use the official endpoint');
  ok(url.includes('api_key=KEY') && url.includes('token=TOK'));
});

// ---------------------------------------------------------------------------
group('Settings UI / schema');
// ---------------------------------------------------------------------------

const schema = require(path.join(ROOT, 'src/settings-ui/schema.js'));

/** Flattens DEFAULT_SETTINGS into dotted leaf paths. */
function leafPaths(object, prefix = '', out = []) {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) leafPaths(value, full, out);
    else out.push(full);
  }
  return out;
}

const allSettingPaths = leafPaths(DEFAULT_SETTINGS);
const describedPaths = schema.describedPaths();
const editablePaths = schema.editablePaths();
const readOnlyPaths = schema.readOnlyPaths();
const internalPaths = schema.INTERNAL_PATHS;

check('every described path is a real setting', () => {
  const missing = describedPaths.filter((p) => !allSettingPaths.includes(p));
  eq(missing, [], 'schema must not describe settings that do not exist');
});
check('every setting is either described or marked internal', () => {
  // This is the guard that keeps the panel complete: a new setting added to
  // DEFAULT_SETTINGS without a schema entry fails here instead of silently
  // being invisible in the UI.
  const uncovered = allSettingPaths.filter(
    (p) => !describedPaths.includes(p) && !internalPaths.includes(p),
  );
  eq(uncovered, [], 'every setting needs a schema field or an entry in INTERNAL_PATHS');
});
check('read-only fields are excluded from the writable set', () => {
  // cache.directory is shown but must not be writable: it is a placeholder for
  // a feature that does not exist yet.
  ok(readOnlyPaths.length > 0, 'there is at least one read-only field');
  const leaked = readOnlyPaths.filter((p) => editablePaths.includes(p));
  eq(leaked, [], 'read-only paths must not be writable');
});
check('every editable path is described too', () => {
  const missing = editablePaths.filter((p) => !describedPaths.includes(p));
  eq(missing, []);
});
check('internal paths really are settings', () => {
  const bogus = internalPaths.filter((p) => !allSettingPaths.includes(p));
  eq(bogus, [], 'INTERNAL_PATHS must not contain stale names');
});
check('no path is both described and internal', () => {
  const both = describedPaths.filter((p) => internalPaths.includes(p));
  eq(both, []);
});
check('section ids and titles are unique', () => {
  const ids = schema.SECTIONS.map((s) => s.id);
  eq(new Set(ids).size, ids.length, 'duplicate section id');
  const titles = schema.SECTIONS.map((s) => s.title);
  eq(new Set(titles).size, titles.length, 'duplicate section title');
});
check('every field has a label and a usable type', () => {
  const kinds = new Set(Object.values(schema.FIELD_TYPES));
  for (const section of schema.SECTIONS) {
    for (const field of section.fields) {
      ok(field.label, `field without a label in ${section.id}`);
      ok(kinds.has(field.type), `unknown field type ${field.type} in ${section.id}`);
      if (field.type === schema.FIELD_TYPES.SELECT) {
        ok(Array.isArray(field.options) && field.options.length, `select ${field.path} needs options`);
      }
      // ACTION and READONLY fields may be computed from a named source; every
      // other kind edits the setting at `path`.
      const computed = field.type === schema.FIELD_TYPES.ACTION || field.source;
      if (!computed) ok(field.path, `field in ${section.id} needs a path`);
    }
  }
});
check('select options carry value and label', () => {
  for (const section of schema.SECTIONS) {
    for (const field of section.fields.filter((f) => f.type === schema.FIELD_TYPES.SELECT)) {
      for (const option of field.options) {
        ok('value' in option, `${field.path}: option without value`);
        ok(option.label, `${field.path}: option without label`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
group('Settings UI / accelerators');
// ---------------------------------------------------------------------------

const accel = require(path.join(ROOT, 'src/settings-ui/accelerator.js'));

/** Builds a minimal KeyboardEvent-like object. */
function key(overrides) {
  return { key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, ...overrides };
}

check('a plain modifier is not a shortcut', () => {
  eq(accel.toAccelerator(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true })), null);
  eq(accel.toAccelerator(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })), null);
});
check('a modifier plus a letter is accepted', () => {
  eq(accel.toAccelerator(key({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true })), 'Control+Alt+M');
});
check('letters are uppercased for Electron', () => {
  eq(accel.toAccelerator(key({ key: 'k', code: 'KeyK', ctrlKey: true })), 'Control+K');
});
check('arrow keys use the Electron names', () => {
  eq(accel.toAccelerator(key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true })), 'Control+Right');
  eq(accel.toAccelerator(key({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true })), 'Control+Up');
});
check('the browser zoom shortcuts round-trip', () => {
  eq(accel.toAccelerator(key({ key: '=', code: 'Equal', ctrlKey: true })), 'Control+=');
  eq(accel.toAccelerator(key({ key: '-', code: 'Minus', ctrlKey: true })), 'Control+Minus');
  eq(accel.toAccelerator(key({ key: '0', code: 'Digit0', ctrlKey: true })), 'Control+0');
});
check('the default play/pause shortcut is representable', () => {
  // Ctrl+/ is the shipped default, so the capture must be able to produce it.
  eq(accel.toAccelerator(key({ key: '/', code: 'Slash', ctrlKey: true })), 'Control+/');
});
check('a shifted symbol stores its base key', () => {
  // Ctrl+Shift+= is what the user presses for Ctrl++; the stored form must be
  // a consistent accelerator either way.
  const value = accel.toAccelerator(key({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }));
  eq(value, 'Control+=');
});
check('a bare letter is refused', () => {
  eq(accel.toAccelerator(key({ key: 'a', code: 'KeyA' })), null, 'no modifier');
});
check('function keys work without a modifier', () => {
  eq(accel.toAccelerator(key({ key: 'F8', code: 'F8' })), 'F8');
});
check('media keys work without a modifier', () => {
  eq(accel.toAccelerator(key({ key: 'MediaPlayPause', code: '' })), 'MediaPlayPause');
});
check('numpad keys use Electron names', () => {
  eq(accel.toAccelerator(key({ key: '5', code: 'Numpad5', ctrlKey: true })), 'Control+num5');
  eq(accel.toAccelerator(key({ key: '+', code: 'NumpadAdd', ctrlKey: true })), 'Control+numadd');
});
check('auto-repeat is ignored', () => {
  eq(accel.toAccelerator(key({ key: 'k', code: 'KeyK', ctrlKey: true, repeat: true })), null);
});
check('unknown keys are refused rather than guessed', () => {
  eq(accel.toAccelerator(key({ key: 'Unidentified', code: 'Unknown', ctrlKey: true })), null);
  eq(accel.toAccelerator(null), null);
});
check('accelerators are displayed in a readable form', () => {
  eq(accel.describeAccelerator('Control+Alt+M'), 'Ctrl + Alt + M');
  eq(accel.describeAccelerator('none'), 'none');
  eq(accel.describeAccelerator(''), 'не задано');
  eq(accel.describeAccelerator(null), 'не задано');
});

// ---------------------------------------------------------------------------
group('Settings UI / channels');
// ---------------------------------------------------------------------------

const settingsChannels = require(path.join(ROOT, 'src/settings-ui/channels.js'));

check('the sandboxed preload inlines the same settings channels', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src/settings-ui/preload.js'), 'utf8');
  for (const [name, value] of Object.entries(settingsChannels.CHANNELS)) {
    if (!preload.includes(`'${value}'`)) throw new Error(`preload.js is missing ${name} = '${value}'`);
  }
});
check('every action the preload can send is allow-listed', () => {
  // The renderer asks for actions by name; the main process refuses anything
  // not on this list, so a typo would silently do nothing.
  const renderer = fs.readFileSync(path.join(ROOT, 'src/settings-ui/index.js'), 'utf8');
  const used = [...renderer.matchAll(/api\.action\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
  const unknown = used.filter((name) => !settingsChannels.ACTIONS.includes(name));
  eq(unknown, [], 'every action used in the renderer must be allow-listed');
});
check('the settings window files referenced by the html all exist', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/settings-ui/index.html'), 'utf8');
  for (const asset of ['index.css', 'index.js', 'schema.js', 'accelerator.js']) {
    ok(html.includes(asset), `index.html must reference ${asset}`);
    ok(fs.existsSync(path.join(ROOT, 'src/settings-ui', asset)), `${asset} must exist`);
  }
});
check('the settings window declares a restrictive CSP', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/settings-ui/index.html'), 'utf8');
  ok(html.includes("default-src 'none'"), 'default-src must be none');
  ok(!html.includes('unsafe-eval'), 'unsafe-eval must not be allowed');
});

// ---------------------------------------------------------------------------
group('Sources');
// ---------------------------------------------------------------------------

const { CHANNELS } = require(path.join(ROOT, 'src/miniplayer/channels.js'));
const vm = await import('node:vm');

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const sourceFiles = walkJs(path.join(ROOT, 'src'));

check('every source file parses', () => {
  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    try {
      // Compiling without running catches syntax errors, including in files
      // that can only be loaded inside Electron.
      new vm.Script(source, { filename: file });
    } catch (error) {
      throw new Error(`${path.relative(ROOT, file)}: ${error.message}`);
    }
  }
});

check('sandboxed preload inlines the same channel names', () => {
  // A sandboxed preload cannot require local modules, so it duplicates the
  // literals; this asserts the two copies cannot drift apart silently.
  const preload = fs.readFileSync(path.join(ROOT, 'src/miniplayer/preload.js'), 'utf8');
  for (const [name, value] of Object.entries(CHANNELS)) {
    if (!preload.includes(`'${value}'`)) {
      throw new Error(`preload.js is missing ${name} = '${value}'`);
    }
  }
});

check('mini player html references its stylesheet and script', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/miniplayer/index.html'), 'utf8');
  for (const asset of ['index.css', 'index.js']) {
    if (!html.includes(asset)) throw new Error(`index.html does not load ${asset}`);
    ok(fs.existsSync(path.join(ROOT, 'src/miniplayer', asset)), `${asset} must exist`);
  }
});

check('mini player html declares a restrictive CSP', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/miniplayer/index.html'), 'utf8');
  ok(html.includes('Content-Security-Policy'), 'CSP meta tag must be present');
  ok(html.includes("default-src 'none'"), 'default-src must be none');
  ok(!html.includes('unsafe-eval'), 'unsafe-eval must not be allowed');
});

// ---------------------------------------------------------------------------
group('Mini player layout');
// ---------------------------------------------------------------------------

const miniCss = fs.readFileSync(path.join(ROOT, 'src/miniplayer/index.css'), 'utf8');
const miniJs = fs.readFileSync(path.join(ROOT, 'src/miniplayer/index.js'), 'utf8');
const miniHtml = fs.readFileSync(path.join(ROOT, 'src/miniplayer/index.html'), 'utf8');
// window.js requires electron at load time, so it is inspected as text.
const miniWindowSource = fs.readFileSync(path.join(ROOT, 'src/miniplayer/window.js'), 'utf8');

check('layout sizes are continuous, not stepped', () => {
  // The old stylesheet switched layout at two hard-coded pixel widths and
  // heights that nothing else knew about; between them nothing changed at all.
  // Everything that can shrink continuously now uses clamp() over container
  // query units.
  ok(miniCss.includes('container-type: size'), 'the player must be a query container');
  const clamped = miniCss.match(/clamp\(/g) ?? [];
  ok(clamped.length >= 12, `expected many clamped lengths, found ${clamped.length}`);
  for (const unit of ['cqi', 'cqb', 'cqmin']) {
    ok(miniCss.includes(unit), `expected ${unit} units so lengths track the window`);
  }
});

check('no width or height breakpoints are left in the stylesheet', () => {
  const breakpoints = miniCss.match(/@media\s*\([^)]*(max-width|max-height)[^)]*\)/g) ?? [];
  eq(breakpoints, [], 'density decisions belong to the ResizeObserver, not to CSS');
});

check('every density the stylesheet styles is produced by the renderer', () => {
  const styled = new Set(
    [...miniCss.matchAll(/\[data-density="([^"]+)"\]/g)].map((m) => m[1]),
  );
  ok(styled.size >= 3, `expected several tiers, found ${[...styled]}`);
  for (const tier of styled) {
    ok(
      miniJs.includes(`'${tier}'`),
      `index.js never produces density "${tier}", so its CSS rules are dead`,
    );
  }
});

check('the density tier is actually driven by a ResizeObserver', () => {
  ok(miniJs.includes('new ResizeObserver'), 'the window is resizable');
  ok(miniJs.includes('dataset.density'), 'the tier must reach the stylesheet');
  ok(miniJs.includes('.observe('), 'the observer must be attached to an element');
});

check('the renderer asks for a size at least once', () => {
  // preload.js exposed requestSize() and window.js handled it, but nothing ever
  // called it, so both halves were dead code.
  ok(miniJs.includes('api.requestSize('), 'index.js must use the resize bridge');
  ok(miniWindowSource.includes('CHANNELS.RESIZE'), 'window.js must keep handling the resize channel');
  ok(
    miniWindowSource.includes(`RESIZE: '${CHANNELS.RESIZE}'`) ||
      fs.readFileSync(path.join(ROOT, 'src/miniplayer/channels.js'), 'utf8').includes(CHANNELS.RESIZE),
    'the resize channel must exist',
  );
});

check('the window floor is at least the smallest tier that can render', () => {
  // MIN_HEIGHT used to be 96 while the layout needed ~120px, and body clips, so
  // the bottom of the controls was cut off instead of shrinking.
  const minHeight = Number(miniWindowSource.match(/MIN_HEIGHT\s*=\s*(\d+)/)?.[1]);
  const minWidth = Number(miniWindowSource.match(/MIN_WIDTH\s*=\s*(\d+)/)?.[1]);
  ok(Number.isInteger(minHeight) && minHeight >= 72, `MIN_HEIGHT ${minHeight} is too small`);
  ok(Number.isInteger(minWidth) && minWidth >= 200, `MIN_WIDTH ${minWidth} is too small`);
});

check('the minimal tier fits inside the window floor', () => {
  // The exact regression: the floor was lower than the smallest layout needed,
  // and `overflow: hidden` turned the difference into clipped controls. The
  // numbers are taken from the clamp() lower bounds, so the guard follows the
  // stylesheet instead of duplicating it.
  const cssVar = (name) =>
    Number(miniCss.match(new RegExp(`${name}:\\s*clamp\\(\\s*(\\d+(?:\\.\\d+)?)px`))?.[1]);

  const padY = cssVar('--pad-y');
  const gap = cssVar('--gap');
  const btnGap = cssVar('--btn-gap');
  const titleFont = cssVar('--fs-title');
  const button = cssVar('--btn');
  const lineHeight = Number(miniCss.match(/font:\s*\d+px\/([\d.]+)/)?.[1]) || 1.35;

  // Minimal tier: padding + title + meta gap + controls + gap + progress bar.
  const needed = padY * 2 + titleFont * lineHeight + 1 + button + btnGap + gap + 14;
  const floor = Number(miniWindowSource.match(/MIN_HEIGHT\s*=\s*(\d+)/)?.[1]);
  ok(
    needed <= floor,
    `minimal tier needs ~${needed.toFixed(1)}px of height but MIN_HEIGHT is ${floor}px`,
  );
});

check('the minimal tier fits inside the window width floor', () => {
  const cssVar = (name) =>
    Number(miniCss.match(new RegExp(`${name}:\\s*clamp\\(\\s*(\\d+(?:\\.\\d+)?)px`))?.[1]);
  const padX = cssVar('--pad-x');
  const button = cssVar('--btn');
  const buttonGap = cssVar('--btn-gap');

  // Minimal tier hides the volume pair, so prev/play/next + pin/close remain.
  const controls = button * 5 + cssVar('--btn-primary') + buttonGap * 5;
  const needed = padX * 2 + controls;
  const floor = Number(miniWindowSource.match(/MIN_WIDTH\s*=\s*(\d+)/)?.[1]);
  ok(
    needed <= floor,
    `minimal tier needs ~${needed}px of width but MIN_WIDTH is ${floor}px`,
  );
});

/*
 * A layout model for the mini player, used to prove that every density tier
 * fits into the window sizes that can actually produce it.
 *
 * The lengths come from the stylesheet's clamp() bounds rather than from a copy
 * in this file, and the thresholds come from the renderer's own densityFor, so
 * this cannot drift away from the code it checks.
 */

/** Compiles the renderer's real densityFor instead of restating its thresholds. */
function loadDensityFor() {
  const source = fs.readFileSync(path.join(ROOT, 'src/miniplayer/index.js'), 'utf8');
  const body = source.match(/function densityFor\(width, height\)\s*\{[\s\S]*?\n\}/)?.[0];
  ok(Boolean(body), 'densityFor must be a top-level function in index.js');
  return new vm.Script(`(${body})`).runInNewContext({});
}

/**
 * Resolves a CSS length expression (`clamp`, `min`, `max`, px and container query
 * units) against a concrete window size, so the layout model below measures the
 * stylesheet instead of restating it.
 */
function makeResolver(width, height) {
  const cqi = width / 100;
  const cqb = height / 100;
  const units = { cqi, cqb, cqmin: Math.min(cqi, cqb), cqmax: Math.max(cqi, cqb) };

  const splitArgs = (source) => {
    const out = [];
    let depth = 0;
    let current = '';
    for (const char of source) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (char === ',' && depth === 0) {
        out.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    out.push(current);
    return out;
  };

  const parse = (source) => {
    const text = source.trim();
    const fn = text.match(/^(clamp|min|max)\(([\s\S]*)\)$/);
    if (fn) {
      const args = splitArgs(fn[2]).map(parse);
      if (fn[1] === 'clamp') {
        ok(args.length === 3, `clamp() needs three arguments: ${text}`);
        return Math.min(Math.max(args[1], args[0]), args[2]);
      }
      return fn[1] === 'min' ? Math.min(...args) : Math.max(...args);
    }
    const term = text.match(/^(-?[\d.]+)(px|cqi|cqb|cqmin|cqmax)?$/);
    if (!term) throw new Error(`cannot resolve length: ${source}`);
    const value = Number(term[1]);
    const unit = term[2];
    return unit && unit !== 'px' ? value * units[unit] : value;
  };

  return (expression) => {
    const value = parse(expression);
    ok(Number.isFinite(value), `unresolved length: ${expression}`);
    return value;
  };
}

/**
 * The container-relative declarations from the stylesheet, read once: the sweep
 * below resolves them for tens of thousands of window sizes.
 */
const CSS_LENGTHS = Object.fromEntries(
  [...miniCss.matchAll(/(--[a-z-]+):\s*([^;{}]*\([^;{}]*\)[^;{}]*)/g)].map((m) => [
    m[1],
    m[2].trim(),
  ]),
);

function cssScaleValues(width, height) {
  const resolve = makeResolver(width, height);
  return Object.fromEntries(
    Object.entries(CSS_LENGTHS).map(([name, declaration]) => [name, resolve(declaration)]),
  );
}

/**
 * What each tier shows, mirroring the `[hidden]` rules and the density
 * selectors in the stylesheet. `columns` is 2 while the artwork sits beside the
 * text, 1 once it is hidden.
 */
const TIER_LAYOUT = {
  comfortable: { cover: true, subline: true, time: true, volume: true, columns: 2 },
  compact: { cover: false, subline: true, time: true, volume: false, columns: 1 },
  short: { cover: true, subline: true, time: false, volume: false, columns: 2 },
  minimal: { cover: false, subline: false, time: false, volume: false, columns: 1 },
};

/**
 * Returns the content box the tier needs. Every length is resolved from the
 * stylesheet, including the progress hit area, so this cannot drift away from
 * the code it checks. `META_GAP` mirrors the fixed gap in the meta column and is
 * asserted below.
 */
const META_GAP = 1;

function requiredBox(winWidth, winHeight, tier) {
  const v = cssScaleValues(winWidth, winHeight);
  const line = Number(miniCss.match(/font:\s*\d+px\/([\d.]+)/)?.[1]) || 1.35;
  const shape = TIER_LAYOUT[tier];

  const titleHeight = v['--fs-title'] * line;
  const sublineHeight = shape.subline ? v['--fs-meta'] * line : 0;
  const controlsHeight = v['--btn'];
  const metaHeight =
    titleHeight + (shape.subline ? META_GAP + sublineHeight + v['--btn-gap'] : 0) + controlsHeight;

  const mainRow =
    shape.columns === 2
      ? Math.max(shape.cover ? v['--cover'] : 0, metaHeight)
      : metaHeight;

  const progressHit = progressHeight(winWidth, winHeight);
  const needHeight =
    v['--pad-y'] * 2 +
    mainRow +
    v['--gap'] +
    progressHit +
    (shape.time ? v['--gap'] + v['--fs-tiny'] * line : 0);

  const buttonCount = shape.volume ? 7 : 5;
  const childCount = buttonCount + 1; // plus the flexible spacer
  const controlsWidth =
    v['--btn'] * (buttonCount - 1) +
    v['--btn-primary'] +
    v['--btn-gap'] * (childCount - 1) +
    (shape.volume ? v['--btn-gap'] * 3 + 1 : 0);
  const textColumn = shape.columns === 2 ? v['--cover'] + v['--gap'] : 0;
  const needWidth = v['--pad-x'] * 2 + textColumn + controlsWidth;

  return { width: needWidth, height: needHeight, gap: v['--gap'] };
}

/** The `.progress` hit area, clamped or fixed, resolved for a window size. */
function progressHeight(winWidth, winHeight) {
  const declaration =
    miniCss.match(/^\.progress\s*\{[\s\S]*?height:\s*([^;]+);/m)?.[1]?.trim() ?? '';
  if (/[(]/.test(declaration)) return makeResolver(winWidth, winHeight)(declaration);
  const fixed = Number(declaration.match(/([\d.]+)px/)?.[1]);
  ok(Number.isFinite(fixed), `cannot read the .progress height: ${declaration}`);
  return fixed;
}

check('every density tier fits every window size that can produce it', () => {
  // The original defect: the window floor was below what the layout required and
  // `overflow: hidden` clipped the controls. Sweeping the whole allowed range
  // catches that, and also catches a tier whose contents grow past its window.
  const densityFor = loadDensityFor();
  const minWidth = Number(miniWindowSource.match(/MIN_WIDTH\s*=\s*(\d+)/)?.[1]);
  const minHeight = Number(miniWindowSource.match(/MIN_HEIGHT\s*=\s*(\d+)/)?.[1]);

  const failures = [];
  let worst = { slack: Infinity };
  // Step 1, not a coarser grid: the binding case is a single tier corner such as
  // 329x112, and a stride of 4 walks straight past it.
  for (let width = minWidth; width <= 600; width += 1) {
    for (let height = minHeight; height <= 280; height += 1) {
      const tier = densityFor(width, height);
      const needed = requiredBox(width, height, tier);
      if (needed.width > width || needed.height > height) {
        failures.push(
          `${tier} at ${width}x${height} needs ` +
            `${needed.width.toFixed(0)}x${needed.height.toFixed(0)}`,
        );
      }
      const slack = Math.min(width - needed.width, height - needed.height);
      if (slack < worst.slack) worst = { slack, tier, width, height };
    }
  }
  eq(
    [...new Set(failures)].slice(0, 6),
    [],
    `${failures.length} overflowing sizes, e.g. ${failures[0] ?? ''}`,
  );
  // A single pixel of slack would pass while still clipping once Chromium rounds
  // a sub-pixel font metric the other way, so require real breathing room.
  ok(
    worst.slack >= 4,
    `tightest fit is ${worst.tier} at ${worst.width}x${worst.height} with only ` +
      `${worst.slack.toFixed(1)}px spare`,
  );
});

check('a tier that hides the time row also drops its grid row', () => {
  // `gap` applies between explicit grid rows whether or not they hold anything,
  // so a hidden `.time` with its area still declared spends a gap on nothing.
  const densityFor = loadDensityFor();
  for (const tier of ['minimal', 'short']) {
    const rule = miniCss.match(
      new RegExp(`\\.player\\[data-density="${tier}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    ok(Boolean(rule), `the ${tier} tier must declare its own grid template`);
    const hidesTime = new RegExp(`\\[data-density="${tier}"\\][^}]*\\.time`).test(miniCss);
    const declaresTime = /grid-template-areas[\s\S]*?"time"/.test(rule);
    ok(
      !(hidesTime && declaresTime),
      `${tier} hides .time but still reserves the grid row, wasting a gap`,
    );
  }
  // The base tier keeps all three rows, which is the case the rule above protects.
  const base = miniCss.match(/^\.player\s*\{([\s\S]*?)\n\}/m)?.[1] ?? '';
  ok((base.match(/"/g)?.length ?? 0) / 2 === 3, 'the base layout has three grid rows');
});

check('density tiers are strictly ordered', () => {
  // A wider window must never ask for a denser layout; inverted thresholds make
  // the tier flip while dragging the same edge.
  const densityFor = loadDensityFor();
  const rank = { minimal: 0, short: 1, compact: 2, comfortable: 3 };
  const problems = [];
  for (const [a, b] of [
    [{ width: 200, height: 80 }, { width: 400, height: 80 }],
    [{ width: 400, height: 80 }, { width: 400, height: 200 }],
    [{ width: 220, height: 70 }, { width: 520, height: 260 }],
  ]) {
    if (rank[densityFor(b.width, b.height)] < rank[densityFor(a.width, a.height)]) {
      problems.push(`${a.width}x${a.height} -> ${b.width}x${b.height}`);
    }
  }
  eq(problems, [], 'growing the window must never reduce the density');
});

check('the density thresholds match the tiers the stylesheet implements', () => {
  const densityFor = loadDensityFor();
  const styled = new Set(
    [...miniCss.matchAll(/\[data-density="([^"]+)"\]/g)].map((m) => m[1]),
  );
  const produced = new Set(
    [
      [200, 80],
      [260, 100],
      [260, 130],
      [400, 130],
      [520, 260],
    ].map(([w, h]) => densityFor(w, h)),
  );

  for (const tier of produced) {
    ok(tier in TIER_LAYOUT, `the layout model does not know tier "${tier}"`);
  }
  // `comfortable` is the unstyled base layout: the first paint uses it before any
  // measurement arrives, so it needs no rule of its own but must be the full one.
  const unstyled = [...produced].filter((tier) => !styled.has(tier));
  eq(unstyled, ['comfortable'], 'only the base tier may lack a density rule');
  ok(miniHtml.includes('data-density="comfortable"'), 'the markup must pre-seed the base tier');
});

check('the base tier really is the full layout', () => {
  // If the unstyled rules hid anything, the comfortable tier would be a lie and
  // the sweep above would be validating the wrong shapes.
  const basePlayer = miniCss.match(/^\.player\s*\{([\s\S]*?)\n\}/m)?.[1] ?? '';
  ok(/grid-template-areas:[\s\S]*"cover meta"/.test(basePlayer),
    'the base layout puts the artwork beside the text');
  ok(/minmax\(0, 1fr\)/.test(basePlayer), 'the text column must be allowed to shrink');
  ok(/grid-template-rows: minmax\(0, 1fr\) auto auto/.test(basePlayer),
    'progress and time must keep their intrinsic height');
  for (const selector of ['.cover', '.volume', '.time', '.subline']) {
    const rule = miniCss.match(new RegExp(`^${selector}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'))?.[1] ?? '';
    ok(!/display:\s*none/.test(rule), `${selector} must be visible by default`);
  }
});

check('grid tracks may shrink so a small window degrades instead of clipping', () => {
  ok(miniCss.includes('minmax(0, 1fr)'), 'flexible tracks must allow shrinking');
  ok(!/grid-template-rows:\s*1fr/.test(miniCss), 'a bare 1fr track cannot shrink below content');
});

check('the mini player window honours the zoom factor', () => {
  ok(miniWindowSource.includes('this.zoom?.attach('), 'the mini window must attach to the zoom controller');
  ok(miniWindowSource.includes('this.zoom.detach('), 'and detach when destroyed');
});

check('the window background follows the system theme', () => {
  // backgroundColor is painted before the document loads, so a hardcoded dark
  // value flashed black on a light desktop.
  ok(miniWindowSource.includes('nativeTheme'), 'must ask Electron for the scheme');
  ok(miniWindowSource.includes('setBackgroundColor'), 'and follow it live');
  ok(miniCss.includes('prefers-color-scheme: light'), 'the stylesheet needs both schemes');
});

check('the primary button is no longer a filled accent disc', () => {
  const rule = miniCss.match(/\.button-primary\s*\{[^}]*\}/)?.[0] ?? '';
  ok(rule.length > 0, 'the primary button rule must exist');
  ok(!/background:\s*var\(--accent\)/.test(rule), 'the accent belongs to the progress bar');
  ok(miniCss.includes('.player[data-state="paused"] .progress-fill'), 'accent stays on the bar');
});

check('every button has a visible keyboard focus ring', () => {
  ok(miniCss.includes(':focus-visible'), 'keyboard users need a focus indicator');
});

check('volume controls are reachable from the window', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src/miniplayer/preload.js'), 'utf8');
  for (const action of ['volumeUp', 'volumeDown']) {
    ok(miniHtml.includes(`id="${action}"`), `index.html is missing the ${action} button`);
    ok(miniJs.includes(`'${action}'`), `index.js never sends ${action}`);
    ok(preload.includes(`'${action}'`), `preload.js does not allow ${action}`);
    ok(miniWindowSource.includes(`'${action}'`), `window.js does not handle ${action}`);
  }
});

check('the progress bar hit area is larger than the bar it draws', () => {
  // Seeking by clicking a 3px line was the single most fiddly interaction.
  const hit = progressHeight(340, 132);
  const barMax = cssScaleValues(340, 132)['--bar-active'];
  ok(hit > barMax, `the ${hit}px hit area must exceed the ${barMax}px drawn bar`);
  ok(hit >= 12, `the hit area must stay comfortable, got ${hit}px`);
  ok(miniHtml.includes('progress-track'), 'the track needs its own element to grow');
});

check('the injected probe does not replace host constructors', () => {
  // An earlier probe wrapped `window.Audio` and `document.createElement` to see
  // media elements that are never attached to the DOM. That replaced globals the
  // whole renderer depends on, and was removed as too invasive for the benefit.
  const probe = require(path.join(ROOT, 'src/player/probe.js'));
  const source = probe.installProbe.toString();
  for (const forbidden of ['window.Audio =', 'document.createElement =', 'window.Audio=']) {
    if (source.includes(forbidden)) throw new Error(`probe must not do: ${forbidden}`);
  }
});
check('the probe observes playback through one prototype method', () => {
  // The narrow hook that replaced the constructor wrappers: it must capture the
  // element and forward the original call unchanged.
  const probe = require(path.join(ROOT, 'src/player/probe.js'));
  const source = probe.installProbe.toString();
  ok(source.includes('HTMLMediaElement.prototype.play'), 'must hook play()');
  ok(source.includes('nativePlay.apply(this, args)'), 'must forward the original call');
  ok(source.includes('remember(this)'), 'must capture the element behind `this`');
});
check('the mod never intercepts network requests', () => {
  // The webRequest observer was removed after it broke artwork and layout: the
  // host pattern needed for sharded audio hosts also matched the artwork CDN,
  // and Electron allows only one listener per webRequest event.
  const offenders = [];
  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (/\.webRequest\s*\.\s*on\w+\s*\(/.test(source)) offenders.push(path.relative(ROOT, file));
  }
  eq(offenders, [], 'no source file may register a webRequest listener');
});
check('the injected probe does not reference outer scope', () => {
  // installProbe() is stringified and evaluated in the renderer, so anything it
  // closes over from module scope would throw there.
  const probe = require(path.join(ROOT, 'src/player/probe.js'));
  const source = probe.installProbe.toString();
  for (const forbidden of ['__dirname', '__filename', 'require(', 'module.exports']) {
    if (source.includes(forbidden)) {
      throw new Error(`installProbe must not use ${forbidden}`);
    }
  }
  ok(source.includes('window.__itirpcProbe'), 'probe must install itself on window');
});

// ---------------------------------------------------------------------------
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(asarDir, { recursive: true, force: true });
fs.rmSync(asarOutDir, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const { name, error } of failures) process.stdout.write(`  FAILED: ${name}\n    ${error.stack}\n`);
  process.exit(1);
}

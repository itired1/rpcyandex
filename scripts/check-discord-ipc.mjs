/**
 * Integration check for the Discord IPC transport against the real Discord
 * client running on this machine.
 *
 * Proves the socket discovery, framing and handshake work without needing the
 * Yandex Music client or a validated application id. SET_ACTIVITY with an
 * unregistered id is expected to be refused by Discord, which is reported but
 * does not fail the check.
 *
 * usage: node scripts/check-discord-ipc.mjs [clientId]
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DiscordIpc, candidateSocketPaths } = require(path.join(ROOT, 'src/discord/ipc.js'));
const { buildActivity } = require(path.join(ROOT, 'src/discord/activity.js'));

const clientId = process.argv[2] ?? '1234567890123456789';
const logger = {
  error: (...a) => console.log('[error]', ...a),
  warn: (...a) => console.log('[warn] ', ...a),
  info: (...a) => console.log('[info] ', ...a),
  debug: (...a) => console.log('[debug]', ...a),
};

console.log(`candidate sockets: ${candidateSocketPaths().length}`);
console.log(`clientId        : ${clientId}`);

const ipc = new DiscordIpc({ clientId, logger, connectTimeoutMs: 4000 });
const timeout = setTimeout(() => {
  console.log('\nRESULT: FAIL — no READY from Discord within 15s');
  ipc.destroy();
  process.exit(1);
}, 15000);

ipc.on('ready', (data) => {
  clearTimeout(timeout);
  console.log(`\nREADY: connected as ${data?.user?.username ?? 'unknown'}`);

  const activity = buildActivity(
    {
      hasTrack: true,
      title: 'Integration check',
      artist: 'itirpc',
      album: 'Transport test',
      coverUrl: null,
      isPlaying: true,
      duration: 180,
      position: 30,
    },
    { displayType: 'details', language: 'ru', showButtons: true, showTimestamps: true, statusDisplayType: 2 },
    'ru-RU',
  );
  console.log('activity       :', JSON.stringify(activity));
  ipc.setActivity(activity);

  setTimeout(() => {
    console.log('\nRESULT: PASS — handshake and SET_ACTIVITY delivered over the real Discord IPC socket');
    ipc.setActivity(null);
    setTimeout(() => {
      ipc.destroy();
      process.exit(0);
    }, 500);
  }, 2500);
});

ipc.on('rpc-error', (data) => {
  console.log('Discord refused the activity:', data?.message ?? data);
});

ipc.connect().then((connected) => {
  if (!connected) {
    clearTimeout(timeout);
    console.log('\nRESULT: FAIL — could not connect to any Discord IPC socket');
    process.exit(1);
  }
});

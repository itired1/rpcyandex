#!/usr/bin/env node
/**
 * itirpc toolset — build, patch and install the itirpc modification into the
 * official Яндекс.Музыка desktop client.
 *
 * The vanilla client ships a single `index.js` main process, a `preload.js`
 * bridge and a Next.js renderer inside `resources/app.asar`. itirpc touches
 * exactly one line of that archive (a `require` at the top of `index.js`) and
 * adds its own `itirpc/` directory, so the patch survives across most client
 * updates and never modifies the renderer bundles.
 *
 * Usage: node toolset.js <command> [options]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = __dirname;

const paths = {
  root: ROOT,
  src: path.join(ROOT, 'src'),
  dist: path.join(ROOT, 'dist'),
  work: path.join(ROOT, 'work'),
  vanilla: path.join(ROOT, 'work', 'vanilla'),
  patched: path.join(ROOT, 'work', 'patched'),
  out: path.join(ROOT, 'work', 'out'),
  meta: path.join(ROOT, 'work', 'vanilla.meta.json'),
};

/** Where the official client lives on this machine. */
function detectClient() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'YandexMusic'),
    path.join(process.env.LOCALAPPDATA ?? '', 'YandexMusic'),
    path.join(process.env.PROGRAMFILES ?? '', 'YandexMusic'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'YandexMusic'),
  ];
  for (const dir of candidates) {
    const asar = path.join(dir, 'resources', 'app.asar');
    if (fs.existsSync(asar)) {
      return { installDir: dir, resourcesDir: path.join(dir, 'resources'), asar };
    }
  }
  return null;
}

function requireClient() {
  const client = detectClient();
  if (!client) {
    fail(
      'Не найден установленный клиент Яндекс.Музыки.\n' +
        'Ожидался путь вида %LOCALAPPDATA%\\Programs\\YandexMusic\\resources\\app.asar',
    );
  }
  return client;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`\n✘ ${msg}\n`);
  process.exit(1);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function human(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function copyDir(from, to, options = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dst, options);
    } else if (entry.isFile()) {
      if (options.onlyNewer && fs.existsSync(dst)) {
        if (fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

async function lib() {
  return {
    asarLib: await import('./scripts/asar-lib.mjs'),
    asarPack: await import('./scripts/asar-pack.mjs'),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInfo() {
  const client = detectClient();
  log('itirpc — информация об окружении\n');
  log(`Node           : ${process.version}`);
  log(`Платформа      : ${process.platform} ${os.arch()}`);
  if (!client) {
    log('Клиент         : НЕ НАЙДЕН');
    return;
  }
  const stat = fs.statSync(client.asar);
  const { asarLib } = await lib();
  const { header, baseOffset } = asarLib.readAsarHeader(client.asar);
  const entries = asarLib.walkAsarEntries(header);
  const pkgEntry = entries.find((e) => e.path === 'package.json');
  let version = '?';
  if (pkgEntry) {
    version = JSON.parse(
      asarLib.readAsarFile(client.asar, header, baseOffset, 'package.json').toString('utf8'),
    ).version;
  }

  log(`Клиент         : ${client.installDir}`);
  log(`Версия         : ${version}`);
  log(`app.asar       : ${human(stat.size)}, ${entries.length} файлов`);
  const patched = isPatched(client.asar);
  log(`Патч установлен: ${patched ? 'да' : 'нет'}`);
  const integrity = integrityStatus(client);
  log(
    `Целостность exe: ${
      integrity.inSync === null ? 'exe не найден' : integrity.inSync ? 'согласована' : 'РАССОГЛАСОВАНА'
    }`,
  );
  log(`Резервная копия: ${fs.existsSync(backupPath(client)) ? 'есть' : 'нет'}`);
  log(`Исходники      : ${fs.existsSync(paths.src) ? 'есть' : 'нет'}`);
  log(`Сборка (dist)  : ${fs.existsSync(paths.dist) ? 'есть' : 'нет'}`);
  log(`Развёрнуто     : ${fs.existsSync(paths.vanilla) ? 'есть' : 'нет'}`);
}

function backupPath(client) {
  return `${client.asar}.itirpc-original`;
}

function exePath(client) {
  return path.join(client.installDir, 'Яндекс Музыка.exe');
}

function exeBackupPath(client) {
  return `${exePath(client)}.itirpc-original`;
}

/** The patch is a single marker line injected at the top of index.js. */
const PATCH_MARKER = "require('./itirpc/bootstrap.js');";
const ANCHOR = "'use strict';";

/** Reads the archive's raw header JSON string without extracting anything. */
function rawHeaderString(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sb = Buffer.alloc(8);
    fs.readSync(fd, sb, 0, 8, 0);
    const hs = sb.readUInt32LE(4);
    const hb = Buffer.alloc(hs);
    fs.readSync(fd, hb, 0, hs, 8);
    return hb.toString('utf8', 8, 8 + hb.readUInt32LE(4));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Electron's EnableEmbeddedAsarIntegrityValidation fuse compares the SHA256 of
 * the raw asar header against a hex string baked into the executable. Any
 * repack changes that header, so the embedded value must be rewritten or the
 * client refuses to start. This is exactly one 64-char ASCII occurrence, so the
 * replacement is length-preserving.
 */
function asarHeaderHash(asarPath) {
  return crypto.createHash('sha256').update(rawHeaderString(asarPath), 'utf8').digest('hex');
}

/** Scans an executable for an embedded header hash without loading it whole. */
function findEmbeddedHash(exeFile, hash, onFound) {
  const fd = fs.openSync(exeFile, 'r');
  const size = fs.fstatSync(fd).size;
  const needle = Buffer.from(hash, 'utf8');
  const chunkSize = 8 * 1024 * 1024;
  const overlap = needle.length - 1;
  let offset = 0;
  let carry = Buffer.alloc(0);
  const found = [];

  try {
    while (offset < size) {
      const len = Math.min(chunkSize, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const hay = carry.length ? Buffer.concat([carry, buf]) : buf;
      const base = offset - carry.length;
      let idx = hay.indexOf(needle);
      while (idx !== -1) {
        found.push(base + idx);
        idx = hay.indexOf(needle, idx + 1);
      }
      carry = hay.subarray(Math.max(0, hay.length - overlap));
      offset += len;
    }
  } finally {
    fs.closeSync(fd);
  }

  if (onFound) onFound(found);
  return found;
}

/**
 * True when the archive already carries the mod. Checks the header structure
 * rather than searching for a substring: paths are split across JSON keys, so
 * `itirpc/bootstrap.js` never appears literally in the header.
 */
function isPatched(asarPath) {
  try {
    const header = JSON.parse(rawHeaderString(asarPath));
    return Boolean(header?.files?.itirpc?.files?.['bootstrap.js']);
  } catch {
    return false;
  }
}

/**
 * Rewrites the asar integrity hash embedded in the executable so it matches the
 * patched archive. Both values are 64 ASCII hex characters, so this is a
 * length-preserving in-place edit and needs only the one occurrence.
 *
 * `previousAsar` is the archive that was installed *before* this run: on a
 * re-install the executable already carries its hash, not the pristine one, so
 * searching for the pristine hash would find nothing.
 *
 * Throws rather than exiting so the caller can roll back a half-applied patch.
 */
function patchExeIntegrity(client, patchedAsar, previousAsar) {
  const exe = exePath(client);
  if (!fs.existsSync(exe)) {
    log('Предупреждение: исполняемый файл не найден, проверка целостности не правится.');
    return { patched: false };
  }

  const newHash = asarHeaderHash(patchedAsar);

  const candidates = [];
  if (previousAsar && fs.existsSync(previousAsar)) candidates.push(asarHeaderHash(previousAsar));
  if (fs.existsSync(backupPath(client))) candidates.push(asarHeaderHash(backupPath(client)));
  candidates.push(asarHeaderHash(client.asar));

  let oldHash = null;
  let positions = [];
  for (const candidate of candidates) {
    if (candidate === newHash) continue;
    const found = findEmbeddedHash(exe, candidate);
    if (found.length === 1) {
      oldHash = candidate;
      positions = found;
      break;
    }
  }

  if (!oldHash) {
    throw new Error(
      'не найдено ни одного известного хэша целостности в exe (ожидалось одно вхождение) — ' +
        'вероятно, клиент обновился и его exe был заменён',
    );
  }

  const fd = fs.openSync(exe, 'r+');
  try {
    fs.writeSync(fd, Buffer.from(newHash, 'utf8'), 0, newHash.length, positions[0]);
  } finally {
    fs.closeSync(fd);
  }
  log(`Хэш целостности в exe обновлён @0x${positions[0].toString(16)}`);
  return { patched: true, offset: positions[0] };
}

/** Copies the whole client into `target` so a patch can be tested non-destructively. */
function copyClientPortable(client, target) {
  log(`Копирование клиента в ${target} (может занять время)...`);
  const started = Date.now();
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(client.installDir, { withFileTypes: true })) {
    const from = path.join(client.installDir, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
  log(`Скопировано за ${((Date.now() - started) / 1000).toFixed(1)} с`);
  return { installDir: target, resourcesDir: path.join(target, 'resources'), asar: path.join(target, 'resources', 'app.asar') };
}

/** Reports whether a client's exe still carries the hash of its own archive. */
function integrityStatus(clientEntry) {
  const exe = exePath(clientEntry);
  if (!fs.existsSync(exe)) return { inSync: null, count: 0 };
  const positions = findEmbeddedHash(exe, asarHeaderHash(clientEntry.asar));
  return { inSync: positions.length === 1, count: positions.length };
}


async function cmdUnpack(force) {
  const client = requireClient();
  const { asarLib } = await lib();

  if (fs.existsSync(paths.vanilla) && !force) {
    log(`Уже развёрнуто: ${paths.vanilla}`);
    log('Используйте --force для повторной распаковки.');
    return;
  }

  // Always unpack from the pristine backup when one exists, never from a
  // patched archive, so repeated patches never stack.
  const backup = backupPath(client);
  const source = fs.existsSync(backup) ? backup : client.asar;

  fs.rmSync(paths.vanilla, { recursive: true, force: true });
  log(`Распаковка ${source}`);
  const started = Date.now();
  const { count } = asarLib.extractAsar(source, paths.vanilla);
  fs.mkdirSync(paths.work, { recursive: true });
  fs.writeFileSync(
    paths.meta,
    JSON.stringify(
      {
        sourceAsar: source,
        originalAsar: client.asar,
        sha256: sha256File(source),
        entries: count,
        unpackedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  log(`Готово: ${count} файлов за ${((Date.now() - started) / 1000).toFixed(1)} с -> ${paths.vanilla}`);
}

/**
 * Copies src/ into dist/itirpc/, optionally stripping comments and blank lines.
 * Only ever applied to itirpc's own sources, never to the client's code.
 */
function cmdBuild(options = {}) {
  if (!fs.existsSync(paths.src)) fail(`Нет каталога исходников: ${paths.src}`);
  const target = path.join(paths.dist, 'itirpc');
  fs.rmSync(target, { recursive: true, force: true });

  if (options.minify) {
    let count = 0;
    const walk = (dir, out) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const from = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(from, out);
          continue;
        }
        if (!entry.name.endsWith('.js')) {
          fs.mkdirSync(out, { recursive: true });
          fs.copyFileSync(from, path.join(out, entry.name));
          continue;
        }
        const stripped = stripJs(fs.readFileSync(from, 'utf8'));
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, entry.name), stripped);
        count += 1;
      }
    };
    walk(paths.src, target);
    log(`Сборка (minified): ${count} JS-файлов -> ${target}`);
  } else {
    copyDir(paths.src, target);
    log(`Сборка (dev): ${target}`);
  }

  if (options.dev) {
    fs.writeFileSync(path.join(target, 'build-info.json'), JSON.stringify({ dev: true }, null, 2));
  }
}

/**
 * Removes `//` and block comments plus blank lines from itirpc's own sources.
 * Regex-based on purpose: it is only used on code we control, and it keeps the
 * build free of any external toolchain (this project has no network access).
 */
function stripJs(source) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | single | double | template
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (ch === '\n') out += '\n';
      i += 1;
      continue;
    }
    // Inside a string literal: copy verbatim, honouring escapes.
    if (ch === '\\') {
      out += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code';
    }
    out += ch;
    i += 1;
  }
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n');
}

/** Injects the bootstrap require into index.js and writes the patched copy. */
function writePatchedIndex(options = {}) {
  const indexPath = path.join(paths.vanilla, 'index.js');
  if (!fs.existsSync(indexPath)) fail(`Не найден ${indexPath}. Сначала выполните unpack.`);
  const original = fs.readFileSync(indexPath, 'utf8');
  fs.mkdirSync(paths.patched, { recursive: true });

  // A patched copy that keeps the original app name shares the real client's
  // profile and single-instance lock, so it would quit immediately while the
  // real client runs. Renaming the app gives the copy its own profile.
  const pkgPath = path.join(paths.patched, 'package.json');
  if (options.isolateName) {
    const pkg = JSON.parse(fs.readFileSync(path.join(paths.vanilla, 'package.json'), 'utf8'));
    pkg.name = options.isolateName;
    pkg.description = `${pkg.description} (itirpc isolated test instance)`;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    log(`Изолированный экземпляр: name="${pkg.name}" (отдельный профиль)`);
  } else {
    fs.rmSync(pkgPath, { force: true });
  }

  if (original.includes(PATCH_MARKER)) {
    log('index.js уже содержит патч, перезапись не требуется.');
    fs.writeFileSync(path.join(paths.patched, 'index.js'), original);
    return { injected: false };
  }

  if (!original.startsWith(ANCHOR)) {
    fail(
      `index.js не начинается с ${ANCHOR}. Структура клиента изменилась — ` +
        'патч нужно адаптировать вручную (см. README, раздел «Обновления клиента»).',
    );
  }

  // Inserted directly after the directive so 'use strict' stays effective and
  // the rest of the bundle is untouched.
  const patched = `${ANCHOR}${PATCH_MARKER}${original.slice(ANCHOR.length)}`;
  fs.writeFileSync(path.join(paths.patched, 'index.js'), patched);
  return { injected: true };
}

async function cmdPatch(options = {}) {
  const client = options.client ?? requireClient();
  const { asarPack } = await lib();

  if (!fs.existsSync(paths.vanilla)) await cmdUnpack(false);
  if (!fs.existsSync(paths.dist)) cmdBuild({ dev: options.dev });

  const pristine = fs.existsSync(backupPath(client)) ? backupPath(client) : client.asar;
  const { injected } = writePatchedIndex(options);

  // The mod directory and the patched index.js are layered over the pristine
  // tree; nothing else in the 2157-file bundle is rewritten.
  const overlays = [paths.dist, paths.patched];
  const outAsar = path.join(paths.out, 'app.asar');

  log(`Упаковка app.asar (база: ${path.basename(pristine)}, слои: itirpc/, patched index.js)`);
  const started = Date.now();
  const result = asarPack.packAsar(paths.vanilla, outAsar, {
    templateAsar: pristine,
    overlays,
    onProgress: (done, total) => {
      if (done % 1500 === 0) log(`  ... ${done}/${total}`);
    },
  });

  log(
    `Готово: ${result.fileCount} файлов, ${human(result.totalSize)} за ` +
      `${((Date.now() - started) / 1000).toFixed(1)} с`,
  );
  log(`Результат: ${outAsar}${injected ? ' (патч внедрён)' : ''}`);
  return outAsar;
}

async function cmdInstall(options = {}) {
  const real = requireClient();
  const client = options.portable
    ? copyClientPortable(real, path.resolve(options.portable))
    : real;

  const backup = backupPath(client);
  const exeBackup = exeBackupPath(client);

  if (isPatched(client.asar) && !fs.existsSync(backup)) {
    fail(
      'app.asar уже пропатчен, но резервной копии нет. Восстановите клиент ' +
        '(переустановка или проверка целостности) и запустите install заново.',
    );
  }

  if (!options.portable && isClientRunning()) {
    if (options.kill) {
      await closeClient();
    } else {
      fail(
        'Клиент Яндекс.Музыки запущен. Закройте его полностью (включая значок в трее), ' +
          'либо добавьте --kill, чтобы toolset закрыл его автоматически.',
      );
    }
  }

  const outAsar = await cmdPatch({ ...options, client });
  const { asarLib } = await lib();

  // --- verify the freshly built archive before it touches anything ---------
  const { header, baseOffset } = asarLib.readAsarHeader(outAsar);
  const entries = asarLib.walkAsarEntries(header);
  if (!asarLib.findEntry(header, 'itirpc/bootstrap.js')) {
    fail('Собранный app.asar не содержит itirpc/bootstrap.js — установка отменена.');
  }
  const indexText = asarLib.readAsarFile(outAsar, header, baseOffset, 'index.js').toString('utf8');
  if (!indexText.includes(PATCH_MARKER)) {
    fail('Собранный index.js не содержит патч — установка отменена.');
  }
  const indexEntry = entries.find((e) => e.path === 'index.js');
  log(
    `Проверка сборки: ${entries.length} файлов, index.js ${human(indexEntry.size)}, ` +
      `${entries.filter((e) => e.path.startsWith('itirpc/')).length} файлов мода.`,
  );

  // --- backups (created once, never overwritten) ---------------------------
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(client.asar, backup);
    log(`Резервная копия asar: ${backup}`);
  }
  if (!fs.existsSync(exeBackup) && fs.existsSync(exePath(client))) {
    fs.copyFileSync(exePath(client), exeBackup);
    log(`Резервная копия exe : ${exeBackup}`);
  }

  // --- apply, with rollback to the *previous* installed state --------------
  // The pristine backups exist for `restore`; these snapshots exist so a failed
  // update returns to the working previous patch instead of silently dropping
  // the user back to vanilla.
  const prevAsar = `${client.asar}.itirpc-prev`;
  const prevExe = `${exePath(client)}.itirpc-prev`;
  const cleanupPrev = () => {
    fs.rmSync(prevAsar, { force: true });
    fs.rmSync(prevExe, { force: true });
  };

  try {
    fs.copyFileSync(client.asar, prevAsar);
    if (fs.existsSync(exePath(client))) fs.copyFileSync(exePath(client), prevExe);

    const staged = `${client.asar}.itirpc-new`;
    fs.copyFileSync(outAsar, staged);
    fs.renameSync(staged, client.asar);
    log(`app.asar установлен (${human(fs.statSync(client.asar).size)})`);

    patchExeIntegrity(client, client.asar, prevAsar);

    const status = integrityStatus(client);
    if (status.inSync === false) {
      throw new Error(`хэш целостности exe не совпал после правки (вхождений: ${status.count})`);
    }
    log('Целостность asar <-> exe согласована.');
    cleanupPrev();
  } catch (error) {
    log(`\nОшибка установки: ${error.message}\nОткат...`);
    if (fs.existsSync(prevAsar)) fs.copyFileSync(prevAsar, client.asar);
    if (fs.existsSync(prevExe)) fs.copyFileSync(prevExe, exePath(client));
    cleanupPrev();
    const status = integrityStatus(client);
    log(
      status.inSync
        ? 'Предыдущее состояние клиента восстановлено.'
        : 'Предупреждение: состояние не удалось согласовать, выполните restore.',
    );
    fail('Установка отменена.');
  }

  log(`\nГотово.${options.launch ? '' : ' Запуск: node toolset.js run'}`);

  if (options.launch && !options.portable) {
    await cmdRun({});
  }
}

function isClientRunning() {
  if (process.platform !== 'win32') return false;
  return clientProcesses().length > 0;
}

/** Running client processes, so they can be reported and optionally closed. */
function clientProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq Яндекс Музыка.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    );
    return out
      .split(/\r?\n/)
      .map((line) => /^"([^"]+)","(\d+)"/.exec(line))
      .filter(Boolean)
      .map((m) => ({ name: m[1], pid: Number(m[2]) }));
  } catch {
    return [];
  }
}

/** Asks the client to exit, then waits for the files to be released. */
async function closeClient({ timeoutMs = 20000 } = {}) {
  const processes = clientProcesses();
  if (processes.length === 0) return true;

  log(`Закрываю клиент (${processes.length} процессов)...`);
  for (const { pid } of processes) {
    try {
      process.kill(pid);
    } catch {
      // The process may already be gone.
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (clientProcesses().length === 0) {
      log('Клиент закрыт.');
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  for (const { pid } of clientProcesses()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Nothing more we can do.
    }
  }
  return clientProcesses().length === 0;
}

async function cmdRestore(options = {}) {
  const client = options.portable
    ? { installDir: path.resolve(options.portable), asar: path.join(path.resolve(options.portable), 'resources', 'app.asar') }
    : requireClient();
  const backup = backupPath(client);
  const exeBackup = exeBackupPath(client);

  if (!fs.existsSync(backup)) fail(`Резервная копия не найдена: ${backup}`);
  if (!options.portable && isClientRunning()) fail('Закройте клиент Яндекс.Музыки перед восстановлением.');

  fs.copyFileSync(backup, client.asar);
  log(`app.asar восстановлен из ${backup}`);
  if (fs.existsSync(exeBackup)) {
    fs.copyFileSync(exeBackup, exePath(client));
    log(`exe восстановлен из ${exeBackup}`);
  }
  log('Исходное состояние клиента возвращено.');
}

/**
 * Diagnoses the three ways this patch can break: the client updated and
 * replaced app.asar, the exe hash no longer matches, or backups went missing.
 */
async function cmdDoctor(options = {}) {
  const client = options.portable
    ? { installDir: path.resolve(options.portable), asar: path.join(path.resolve(options.portable), 'resources', 'app.asar') }
    : requireClient();

  log(`Клиент: ${client.installDir}\n`);
  const problems = [];

  const patched = isPatched(client.asar);
  log(`1. Патч в app.asar          : ${patched ? 'есть' : 'нет'}`);

  const hasAsarBackup = fs.existsSync(backupPath(client));
  const hasExeBackup = fs.existsSync(exeBackupPath(client));
  log(`2. Резервные копии          : asar=${hasAsarBackup ? 'есть' : 'НЕТ'}, exe=${hasExeBackup ? 'есть' : 'НЕТ'}`);
  if (patched && (!hasAsarBackup || !hasExeBackup)) {
    problems.push('Патч установлен, но резервная копия отсутствует — откат невозможен.');
  }

  const status = integrityStatus(client);
  log(
    `3. Хэш целостности в exe    : ${
      status.inSync === null ? 'exe не найден' : status.inSync ? 'совпадает с asar' : `НЕ СОВПАДАЕТ (вхождений: ${status.count})`
    }`,
  );
  if (status.inSync === false) {
    problems.push(
      'Хэш в exe не соответствует текущему app.asar. Скорее всего клиент обновился и ' +
        'заменил app.asar, оставив пропатченный exe. Клиент не запустится: выполните restore.',
    );
  }

  const { asarLib } = await lib();
  try {
    const { header, baseOffset } = asarLib.readAsarHeader(client.asar);
    const pkg = JSON.parse(
      asarLib.readAsarFile(client.asar, header, baseOffset, 'package.json').toString('utf8'),
    );
    log(`4. Версия клиента           : ${pkg.version}`);
    const index = asarLib.readAsarFile(client.asar, header, baseOffset, 'index.js').toString('utf8');
    log(`5. Якорь патча в index.js   : ${index.startsWith(ANCHOR) ? `найден (${ANCHOR})` : 'НЕ НАЙДЕН'}`);
    if (!index.startsWith(ANCHOR)) {
      problems.push('index.js больше не начинается с \'use strict\' — структура клиента изменилась.');
    }
  } catch (error) {
    problems.push(`Не удалось прочитать app.asar: ${error.message}`);
  }

  log('');
  if (problems.length === 0) {
    log('Диагностика: проблем не обнаружено.');
  } else {
    for (const p of problems) log(`  ! ${p}`);
    process.exitCode = 1;
  }
}

async function cmdVerify() {
  const client = requireClient();
  const asarPath = fs.existsSync(path.join(paths.out, 'app.asar'))
    ? path.join(paths.out, 'app.asar')
    : client.asar;
  const { asarLib } = await lib();
  const { header, baseOffset } = asarLib.readAsarHeader(asarPath);
  const entries = asarLib.walkAsarEntries(header);
  const byPath = new Map(entries.map((e) => [e.path, e]));

  let ok = 0;
  let bad = 0;
  for (const entry of entries) {
    if (entry.unpacked) continue;
    const data = asarLib.readAsarFile(asarPath, header, baseOffset, entry.path);
    if (data.length !== entry.size) {
      bad += 1;
      log(`  РАЗМЕР: ${entry.path} header=${entry.size} факт=${data.length}`);
      continue;
    }
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (entry.hash && hash !== entry.hash) {
      bad += 1;
      log(`  ХЭШ: ${entry.path}`);
      continue;
    }
    ok += 1;
  }

  log(`\n${asarPath}`);
  log(`Проверено: ${ok} ok, ${bad} ошибок, всего ${entries.length} записей`);
  const modFiles = entries.filter((e) => e.path.startsWith('itirpc/'));
  log(`Файлов мода: ${modFiles.length}`);
  const indexText = asarLib.readAsarFile(asarPath, header, baseOffset, 'index.js').toString('utf8');
  log(`index.js патч: ${indexText.includes(PATCH_MARKER) ? 'есть' : 'НЕТ'}`);
  if (bad > 0) process.exitCode = 1;
}

async function cmdRun(options = {}) {
  const client = options.portable
    ? { installDir: path.resolve(options.portable) }
    : requireClient();
  const exe = path.join(client.installDir, 'Яндекс Музыка.exe');
  if (!fs.existsSync(exe)) fail(`Не найден исполняемый файл: ${exe}`);

  // A parent process may export ELECTRON_RUN_AS_NODE (agent shells and IDE
  // terminals often do). With it set the client starts as plain Node, finds no
  // script and exits silently with code 0 — indistinguishable from a broken
  // patch, so it is stripped explicitly.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  log(`Запуск: ${exe}`);
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', env });
  child.unref();
}

/** Path to the mod's settings file inside the client profile. */
function configPath() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'YandexMusic', 'itirpc', 'config.json');
}

/**
 * Reads or writes the mod's settings without hand-editing JSON.
 *
 *   node toolset.js config                     — print the whole config
 *   node toolset.js config discord.clientId    — print one value
 *   node toolset.js config discord.clientId 123 — set a value
 */
async function cmdConfig(options) {
  const [key, ...rest] = options.positional;
  const file = configPath();

  // Read defaults from the mod sources so the command works before first run.
  const { DEFAULT_SETTINGS } = require('./src/core/settings.js');
  let current = DEFAULT_SETTINGS;
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Not created yet: fall back to defaults.
  }

  const merged = (defaults, value) => {
    const out = { ...defaults };
    for (const [k, v] of Object.entries(value ?? {})) {
      out[k] =
        v && typeof v === 'object' && !Array.isArray(v) && defaults[k] ? merged(defaults[k], v) : v;
    }
    return out;
  };

  if (!key) {
    log(`Файл: ${file}${fs.existsSync(file) ? '' : ' (ещё не создан, показаны значения по умолчанию)'}\n`);
    log(JSON.stringify(merged(DEFAULT_SETTINGS, current), null, 2));
    return;
  }

  if (rest.length === 0) {
    const value = key
      .split('.')
      .reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), merged(DEFAULT_SETTINGS, current));
    log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    return;
  }

  const raw = rest.join(' ');
  let parsed = raw;
  if (raw === 'true' || raw === 'false') parsed = raw === 'true';
  else if (raw !== '' && !Number.isNaN(Number(raw))) parsed = Number(raw);

  const keys = key.split('.');
  const last = keys.pop();
  let cursor = current;
  for (const part of keys) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[last] = parsed;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  log(`${key} = ${JSON.stringify(parsed)}`);
  log(`Сохранено в ${file}. Мод подхватит изменение без перезапуска.`);
}

const COMMANDS = {
  info: { run: cmdInfo, help: 'Показать окружение, версию клиента и статус патча' },
  unpack: { run: (o) => cmdUnpack(o.force), help: 'Распаковать app.asar в work/vanilla [--force]' },
  build: { run: (o) => cmdBuild(o), help: 'Собрать мод из src/ в dist/itirpc [-d] [-m]' },
  patch: { run: (o) => cmdPatch(o), help: 'Собрать пропатченный app.asar в work/out' },
  install: {
    run: (o) => cmdInstall(o),
    help: 'Установить патч. --kill — закрыть клиент, --launch — запустить после',
  },
  restore: { run: (o) => cmdRestore(o), help: 'Восстановить asar и exe из резервных копий' },
  doctor: { run: (o) => cmdDoctor(o), help: 'Диагностика: патч, бэкапы, согласованность хэша exe' },
  config: {
    run: (o) => cmdConfig(o),
    help: 'Читать/писать настройки: config [ключ] [значение]',
  },
  verify: { run: cmdVerify, help: 'Проверить целостность и наличие патча в собранном app.asar' },
  run: { run: (o) => cmdRun(o), help: 'Запустить клиент Яндекс.Музыки' },
  rebuild: {
    run: async (o) => {
      cmdBuild({ dev: true, ...o });
      await cmdInstall({ dev: true, ...o });
    },
    help: 'Быстрая сборка для разработки: build -d + install',
  },
};

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  const portableIndex = argv.findIndex((a) => a === '--portable' || a === '-p');
  const flags = new Set(['--force', '-f', '--dev', '-d', '--minify', '-m', '--kill', '--launch', '-l', '--isolate', '--portable', '-p']);
  const positional = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--portable' || arg === '-p') {
      i += 1; // its value belongs to the flag, not to the command arguments
      continue;
    }
    if (flags.has(arg)) continue;
    positional.push(arg);
  }
  const options = {
    force: argv.includes('--force') || argv.includes('-f'),
    dev: argv.includes('--dev') || argv.includes('-d'),
    minify: argv.includes('--minify') || argv.includes('-m'),
    portable: portableIndex > -1 ? argv[portableIndex + 1] : null,
    isolateName: argv.includes('--isolate') ? 'YandexMusicItirpcTest' : null,
    kill: argv.includes('--kill'),
    launch: argv.includes('--launch') || argv.includes('-l'),
    positional,
  };

  if (command === 'help' || command === '--help' || command === '-h') {
    log('itirpc toolset\n\nКоманды:');
    for (const [name, def] of Object.entries(COMMANDS)) log(`  ${name.padEnd(9)} ${def.help}`);
    return;
  }

  const def = COMMANDS[command];
  if (!def) fail(`Неизвестная команда: ${command}. Запустите "node toolset.js help".`);
  await def.run(options);
}

main().catch((error) => fail(error?.stack ?? String(error)));

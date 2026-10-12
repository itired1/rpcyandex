'use strict';

/**
 * Track downloader.
 *
 * Downloads whatever the client is currently streaming, using the URL captured
 * by the stream observer. Because it goes through the app's own session, the
 * audio is fetched with the account's real entitlement — the mod adds a "save
 * this to disk" action, it does not unlock anything the subscription does not
 * already allow.
 *
 * Only one download runs at a time: the client streams a single track, and
 * parallel writes to the same folder add failure modes without adding value.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pipeline } = require('node:stream/promises');
const { spawn, spawnSync } = require('node:child_process');

/** Characters Windows forbids in file names, plus control characters. */
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Device names that cannot be used as a file name on Windows. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASE_LENGTH = 150;

/**
 * Makes an arbitrary track title safe to use as a file name on Windows.
 * Trailing dots and spaces are stripped because Windows silently drops them,
 * which would make the written path differ from the one we report.
 */
function sanitizeFileName(value, fallback = 'track') {
  let name = String(value ?? '')
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim();

  name = name.replace(/[. ]+$/, '');
  if (!name) name = fallback;
  if (RESERVED_NAMES.test(name)) name = `_${name}`;
  if (name.length > MAX_BASE_LENGTH) name = name.slice(0, MAX_BASE_LENGTH).trim();
  return name || fallback;
}

/** Builds `Artist - Title.ext`, falling back gracefully on missing metadata. */
function buildFileName(track, extension) {
  const artist = sanitizeFileName(track?.artist, '');
  const title = sanitizeFileName(track?.title, 'track');
  const base = artist ? `${artist} - ${title}` : title;
  const ext = String(extension || '.bin').startsWith('.') ? extension : `.${extension}`;
  return `${sanitizeFileName(base)}${ext}`;
}

/**
 * Picks a file extension, preferring the URL because the CDN often sends no
 * usable content type at all (observed: `content-type` missing entirely).
 *
 * Yandex names the container as a path token rather than a real suffix, e.g.
 * `…/aac192-mp4?container=mp4&codec=mp4a.40.2`, so a plain "does it end in
 * .mp3" check is not enough and would save a perfectly good track as `.bin`.
 */
function extensionFor(url, contentType) {
  const source = String(url ?? '');

  // A real file suffix, if there is one.
  const fromSuffix = /\.(mp3|aac|m4a|mp4|flac|opus|ogg|webm)(?:[?#]|$)/i.exec(source);
  if (fromSuffix) return `.${fromSuffix[1].toLowerCase()}`;

  // The container token Yandex actually uses, optionally carrying a bitrate.
  const containerToken = /(?:^|[-_/.])(aac|mp3|flac|opus|alac)[-_]?\d{0,4}[-_](mp4|m4a|aac|mp3|webm|ogg)(?=[-_.?/&#]|$)/i.exec(
    source,
  );
  if (containerToken) {
    const container = containerToken[2].toLowerCase();
    // AAC in an MP4 container is an .m4a file; anything else keeps its name.
    if (container === 'mp4' || container === 'm4a') return '.m4a';
    return `.${container}`;
  }

  // A bare codec token with no container, e.g. `aac192-file`. A codec served
  // this way is normally AAC in an MP4 container.
  const codecToken = /(?:^|[-_/.])(aac|mp3|flac|opus|alac)[-_]?\d{0,4}(?=[-_.?/&#]|$)/i.exec(source);
  if (codecToken) {
    const codec = codecToken[1].toLowerCase();
    if (codec === 'aac' || codec === 'alac') return '.m4a';
    if (codec === 'opus') return '.opus';
    return `.${codec}`;
  }

  const type = String(contentType ?? '').toLowerCase();
  if (type.includes('mpeg') || type.includes('mp3')) return '.mp3';
  if (type.includes('flac')) return '.flac';
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('webm')) return '.webm';
  if (type.includes('mp4') || type.includes('aac') || type.includes('m4a')) return '.m4a';
  return '.bin';
}

/** Locates an ffmpeg binary; returns null when it is not installed. */
function findFfmpeg(configuredPath) {
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (probe.status === 0) {
      const first = probe.stdout.split(/\r?\n/).find((line) => line.trim());
      return first ? first.trim() : null;
    }
  } catch {
    // `where` is missing or blocked; treat ffmpeg as unavailable.
  }
  return null;
}

class Downloader extends EventEmitter {
  constructor({ settings, logger, transport }) {
    super();
    this.settings = settings;
    this.logger = logger;
    this.transport = transport;
    this.active = null;
    this.abortController = null;
  }

  get config() {
    return this.settings.get('downloads') ?? {};
  }

  /** Destination folder; falls back to a subfolder of the user's Music. */
  get directory() {
    const configured = this.config.directory;
    if (typeof configured === 'string' && configured.trim()) return configured;
    return path.join(this.#defaultMusicDir(), 'itirpc');
  }

  #defaultMusicDir() {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
    return path.join(home, 'Music');
  }

  get ffmpegPath() {
    return findFfmpeg(this.config.ffmpegPath);
  }

  /** Progress snapshot for UI, or null when idle. */
  get status() {
    if (!this.active) return null;
    return {
      title: this.active.track?.title ?? null,
      artist: this.active.track?.artist ?? null,
      received: this.active.received,
      total: this.active.total,
      percent:
        this.active.total > 0
          ? Math.round((this.active.received / this.active.total) * 100)
          : null,
      file: this.active.targetPath,
    };
  }

  cancel() {
    if (this.abortController) this.abortController.abort();
  }

  /**
   * Downloads one track.
   * @returns {Promise<{ok: boolean, path?: string, bytes?: number, error?: string, converted?: boolean}>}
   */
  async download(track, url) {
    if (!this.config.enabled) {
      return {
        ok: false,
        error:
          'скачивание отключено (downloads.enabled = false): поток клиента зашифрован, ' +
          'сохранённый файл будет нечитаемым',
      };
    }
    if (this.active) return { ok: false, error: 'уже идёт загрузка другого трека' };
    if (!url) return { ok: false, error: 'нет ссылки на поток: включите воспроизведение' };
    if (typeof this.transport !== 'function') return { ok: false, error: 'транспорт не настроен' };

    const abort = new AbortController();
    this.abortController = abort;

    try {
      fs.mkdirSync(this.directory, { recursive: true });

      // Logged before the request: without this a hung or blocked request looks
      // identical to a download that is merely slow.
      this.logger.debug(`Запрос потока: ${url.slice(0, 200)}`);
      const response = await this.transport(url);
      this.logger.debug(
        `Ответ потока: HTTP ${response.statusCode}, ` +
          `content-type=${response.headers?.['content-type'] ?? '?'}, ` +
          `content-length=${response.headers?.['content-length'] ?? '?'}`,
      );
      if (response.statusCode !== 200) {
        // Drain the body so the socket can be reused and no data is left queued.
        response.body?.resume?.();
        return { ok: false, error: `сервер вернул HTTP ${response.statusCode}` };
      }

      const extension = extensionFor(url, response.headers?.['content-type']);
      const fileName = this.#uniqueName(buildFileName(track, extension));
      const targetPath = path.join(this.directory, fileName);
      const partialPath = `${targetPath}.part`;

      const total = Number(response.headers?.['content-length']) || 0;
      this.active = { track, received: 0, total, targetPath };
      this.logger.info(`Скачивание: ${fileName}${total ? ` (${total} байт)` : ''}`);
      this.emit('start', { ...this.active });

      const out = fs.createWriteStream(partialPath);
      response.body.on('data', (chunk) => {
        this.active.received += chunk.length;
        this.emit('progress', this.status);
      });
      response.body.on('aborted', () => abort.abort());

      const onAbort = () => response.body.destroy(new Error('cancelled'));
      abort.signal.addEventListener('abort', onAbort, { once: true });

      try {
        await pipeline(response.body, out);
      } finally {
        abort.signal.removeEventListener('abort', onAbort);
      }

      // Rename only once the whole body landed, so a partial file never looks
      // like a finished download.
      fs.renameSync(partialPath, targetPath);
      const bytes = fs.statSync(targetPath).size;

      const converted = await this.#maybeConvertToMp3(targetPath, track);
      const finalPath = converted.path ?? targetPath;

      this.logger.info(
        `Скачано: ${path.basename(finalPath)} (${bytes} байт)` +
          (converted.converted ? ' → MP3' : ''),
      );
      this.emit('done', { path: finalPath, bytes });
      return { ok: true, path: finalPath, bytes, converted: converted.converted };
    } catch (error) {
      const cancelled = abort.signal.aborted;
      this.logger.warn('Скачивание не удалось:', error.message);
      return { ok: false, error: cancelled ? 'отменено' : error.message };
    } finally {
      this.active = null;
      this.abortController = null;
      this.emit('idle');
    }
  }

  /** Appends ` (2)`, ` (3)`… so an existing file is never overwritten. */
  #uniqueName(fileName) {
    const parsed = path.parse(fileName);
    let candidate = fileName;
    let counter = 2;
    while (fs.existsSync(path.join(this.directory, candidate))) {
      candidate = `${parsed.name} (${counter})${parsed.ext}`;
      counter += 1;
      if (counter > 999) break;
    }
    return candidate;
  }

  /**
   * Converts to MP3 when asked and possible.
   *
   * Yandex serves AAC in an MP4 container for most tracks, so a real conversion
   * needs ffmpeg. It is not bundled (the mod ships no binaries), so when it is
   * absent the original file is kept and that is reported rather than silently
   * pretending the file is an MP3.
   */
  async #maybeConvertToMp3(sourcePath, track) {
    if (!this.config.convertToMp3) return { converted: false, path: sourcePath };
    if (path.extname(sourcePath).toLowerCase() === '.mp3') {
      return { converted: false, path: sourcePath };
    }

    const ffmpeg = this.ffmpegPath;
    if (!ffmpeg) {
      this.logger.warn(
        'Конвертация в MP3 запрошена, но ffmpeg не найден — сохранён исходный формат. ' +
          'Укажите путь в downloads.ffmpegPath или установите ffmpeg в PATH.',
      );
      return { converted: false, path: sourcePath };
    }

    const parsed = path.parse(sourcePath);
    const mp3Path = path.join(parsed.dir, `${parsed.name}.mp3`);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', mp3Path];

    this.logger.info('Конвертация в MP3 через ffmpeg...');
    const code = await new Promise((resolve) => {
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => resolve(-1));
      child.on('close', (value) => resolve(value));
    });

    if (code === 0 && fs.existsSync(mp3Path)) {
      fs.rmSync(sourcePath, { force: true });
      return { converted: true, path: mp3Path };
    }

    this.logger.warn(`ffmpeg завершился с кодом ${code}; оставлен исходный файл`);
    return { converted: false, path: sourcePath };
  }
}

module.exports = {
  Downloader,
  sanitizeFileName,
  buildFileName,
  extensionFor,
  findFfmpeg,
  MAX_BASE_LENGTH,
};

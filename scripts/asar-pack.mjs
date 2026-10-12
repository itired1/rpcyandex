/**
 * Dependency-free ASAR writer.
 *
 * Reproduces the exact on-disk layout produced by @electron/asar:
 *
 *   [0..8)             size pickle:   [uint32 4][uint32 headerSize]
 *   [8..8+headerSize)  header pickle: [uint32 payloadSize][uint32 jsonLength][json][pad]
 *   [8+headerSize..)   file contents, in header order
 *
 * A file entry is written as
 *   {"size":N,"offset":"N","integrity":{"algorithm":"SHA256","hash":"<hex>",
 *    "blockSize":4194304,"blocks":["<hex>",...]}}
 * which is the layout the vanilla Яндекс.Музыка bundle uses. Integrity data is
 * always recomputed from the bytes actually written, so a patched file stays
 * valid even when embedded asar integrity validation is enabled.
 *
 * Passing `templateAsar` makes the output follow the original entry order for
 * both the header and the content region, which is what allows an untouched
 * repack to be byte-identical to the shipped archive.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readAsarHeader, walkAsarEntries } from './asar-lib.mjs';

const DEFAULT_BLOCK_SIZE = 4 * 1024 * 1024;

/** Byte-order sort, matching what readdir yields on NTFS and what asar emits. */
function sortNames(names) {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Recursively lists files as `{ rel, full, size }`, path-sorted. */
export function collectFiles(dir, prefix = '', out = []) {
  for (const name of sortNames(fs.readdirSync(dir))) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = fs.lstatSync(full);
    if (st.isDirectory()) {
      collectFiles(full, rel, out);
    } else if (st.isFile()) {
      out.push({ rel, full, size: st.size });
    }
  }
  return out;
}

/**
 * Merges a base directory with overlay directories (later overlays win) into a
 * single `rel -> file` map. This lets the patcher add the mod and replace
 * `index.js` without copying the whole 50 MiB bundle on every run.
 */
export function collectFilesMerged(baseDir, overlayDirs = []) {
  const map = new Map();
  for (const file of collectFiles(baseDir)) map.set(file.rel, file);
  for (const dir of overlayDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of collectFiles(dir)) map.set(file.rel, file);
  }
  return map;
}

function integrityFor(full, blockSize) {
  const data = fs.readFileSync(full);
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    blocks.push(
      crypto.createHash('sha256').update(data.subarray(offset, offset + blockSize)).digest('hex'),
    );
  }
  if (blocks.length === 0) blocks.push(crypto.createHash('sha256').update(data).digest('hex'));

  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(data).digest('hex'),
    blockSize,
    blocks,
  };
}

/**
 * Decides the order in which entries appear in the header and in the content
 * region. With a template, the original order wins and new files are appended
 * to the end; without one, the sorted directory walk order is used.
 */
function resolveOrder(sourceFiles, templateHeader) {
  const byPath = new Map(sourceFiles.map((f) => [f.rel, f]));
  if (!templateHeader) return sourceFiles;

  const ordered = [];
  for (const entry of walkAsarEntries(templateHeader)) {
    const file = byPath.get(entry.path);
    if (file) {
      ordered.push(file);
      byPath.delete(entry.path);
    }
  }
  // Anything the mod (or a future client version) added that the template lacks.
  ordered.push(...sortNames([...byPath.keys()]).map((rel) => byPath.get(rel)));
  return ordered;
}
function buildHeader(orderedFiles, templateHeader, blockSize) {
  const executable = new Set(
    templateHeader
      ? walkAsarEntries(templateHeader)
          .filter((e) => e.executable)
          .map((e) => e.path)
      : [],
  );

  const offsets = new Map();
  let position = 0;
  for (const file of orderedFiles) {
    offsets.set(file.rel, position);
    position += file.size;
  }

  const tree = { files: new Map() };
  for (const file of orderedFiles) {
    const parts = file.rel.split('/');
    let cursor = tree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = parts[i];
      if (!cursor.files.has(dir)) cursor.files.set(dir, { files: new Map() });
      cursor = cursor.files.get(dir);
    }
    cursor.files.set(parts[parts.length - 1], file);
  }

  const serialize = (node) => {
    const out = {};
    for (const [name, value] of node.files) {
      if (value.files) {
        out[name] = { files: serialize(value) };
        continue;
      }
      const entry = {
        size: value.size,
        offset: String(offsets.get(value.rel)),
        integrity: integrityFor(value.full, blockSize),
      };
      if (executable.has(value.rel)) entry.executable = true;
      out[name] = entry;
    }
    return out;
  };

  return { header: { files: serialize(tree) }, totalSize: position };
}

/** Serializes the two leading pickles around the JSON header. */
function serializeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padded = 4 + json.length + ((4 - ((4 + json.length) % 4)) % 4);

  const headerPickle = Buffer.alloc(4 + padded);
  headerPickle.writeUInt32LE(padded, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);

  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);

  return Buffer.concat([sizePickle, headerPickle]);
}

export function packAsar(sourceDir, outPath, options = {}) {
  const { templateAsar, onProgress, overlays = [] } = options;
  const templateHeader = templateAsar ? readAsarHeader(templateAsar).header : null;
  const blockSize = templateHeader
    ? (walkAsarEntries(templateHeader)[0]?.blockSize ?? DEFAULT_BLOCK_SIZE)
    : DEFAULT_BLOCK_SIZE;

  const sourceFiles = [...collectFilesMerged(sourceDir, overlays).values()];
  const ordered = resolveOrder(sourceFiles, templateHeader);
  const { header, totalSize } = buildHeader(ordered, templateHeader, blockSize);
  const prefix = serializeHeader(header);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(outPath, 'w');
  try {
    fs.writeSync(fd, prefix);
    let done = 0;
    for (const file of ordered) {
      fs.writeSync(fd, fs.readFileSync(file.full));
      done += 1;
      if (onProgress && done % 300 === 0) onProgress(done, ordered.length);
    }
  } finally {
    fs.closeSync(fd);
  }

  return { fileCount: ordered.length, totalSize, headerBytes: prefix.length, blockSize, outPath };
}

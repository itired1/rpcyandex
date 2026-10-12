/**
 * Minimal, dependency-free ASAR reader.
 *
 * ASAR layout on disk:
 *   [0..8)              pickle containing a UInt32 header size
 *   [8..8+size)         pickle containing a UTF-8 JSON header string
 *   [8+size .. EOF)     concatenated file contents ("base offset")
 *
 * Each header entry is either a directory ({ files: {...} }) or a file
 * ({ size, offset: "<string>", unpacked?: true }). `offset` is a decimal
 * string relative to the base offset.
 */
import fs from 'node:fs';
import path from 'node:path';

const HEADER_PICKLE_SIZE = 8;

export function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(HEADER_PICKLE_SIZE);
    fs.readSync(fd, sizeBuf, 0, HEADER_PICKLE_SIZE, 0);
    const headerSize = sizeBuf.readUInt32LE(4);

    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, HEADER_PICKLE_SIZE);

    // Shape of the header pickle: [payloadSize][stringLength][string bytes]
    const jsonLength = headerBuf.readUInt32LE(4);
    const json = headerBuf.toString('utf8', 8, 8 + jsonLength);

    return { header: JSON.parse(json), baseOffset: HEADER_PICKLE_SIZE + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

/** Normalises a path to forward slashes and strips leading/trailing ones. */
export function normalizeEntryPath(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Walks the header and yields one record per file.
 * @param {object} header
 * @returns {Array<{path: string, size: number, offset: number, unpacked: boolean,
 *   executable: boolean, blockSize: number|undefined, hash: string|undefined}>}
 */
export function walkAsarEntries(header) {
  const out = [];

  const visit = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const entryPath = prefix ? `${prefix}/${name}` : name;
      if (child.files) {
        visit(child, entryPath);
      } else {
        out.push({
          path: entryPath,
          size: child.size ?? 0,
          offset: Number(child.offset ?? 0),
          unpacked: Boolean(child.unpacked),
          executable: Boolean(child.executable),
          blockSize: child.integrity?.blockSize,
          hash: child.integrity?.hash,
        });
      }
    }
  };

  visit(header, '');
  return out;
}

export function findEntry(header, entryPath) {
  const parts = normalizeEntryPath(entryPath).split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}

export function readAsarFile(asarPath, header, baseOffset, entryPath) {
  const entry = findEntry(header, entryPath);
  if (!entry || entry.files) {
    throw new Error(`Not a file in asar: ${entryPath}`);
  }
  if (entry.unpacked) {
    const unpackedPath = `${asarPath}.unpacked/${normalizeEntryPath(entryPath)}`;
    return fs.readFileSync(unpackedPath);
  }
  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** Extracts every entry (or a filtered subset) into destDir. */
export function extractAsar(asarPath, destDir, options = {}) {
  const { filter, onProgress } = options;
  const { header, baseOffset } = readAsarHeader(asarPath);
  const entries = walkAsarEntries(header).filter((e) => (filter ? filter(e.path) : true));
  const fd = fs.openSync(asarPath, 'r');
  try {
    let done = 0;
    for (const entry of entries) {
      const target = path.join(destDir, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });

      if (entry.unpacked) {
        const unpackedPath = `${asarPath}.unpacked/${entry.path}`;
        if (fs.existsSync(unpackedPath)) {
          fs.copyFileSync(unpackedPath, target);
        }
      } else {
        const buf = Buffer.alloc(entry.size);
        fs.readSync(fd, buf, 0, entry.size, baseOffset + entry.offset);
        fs.writeFileSync(target, buf);
      }

      done += 1;
      if (onProgress && done % 200 === 0) onProgress(done, entries.length, entry.path);
    }
    return { count: entries.length, header, baseOffset };
  } finally {
    fs.closeSync(fd);
  }
}

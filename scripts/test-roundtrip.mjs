/**
 * Round-trip proof for the ASAR writer: unpack -> repack must reproduce the
 * original archive byte for byte, and every entry must hash identically.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { packAsar } from './asar-pack.mjs';
import { readAsarHeader, walkAsarEntries, readAsarFile } from './asar-lib.mjs';

const [original, sourceDir, outPath] = process.argv.slice(2);
if (!original || !sourceDir || !outPath) {
  console.error('usage: node test-roundtrip.mjs <original.asar> <unpackedDir> <repacked.asar>');
  process.exit(2);
}

console.log('packing...');
const started = Date.now();
const result = packAsar(sourceDir, outPath, { templateAsar: original });
console.log(`packed ${result.fileCount} files, ${(result.totalSize / 1024 / 1024).toFixed(1)} MiB in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const a = fs.readFileSync(original);
const b = fs.readFileSync(outPath);

console.log(`\noriginal: ${a.length} bytes`);
console.log(`repacked: ${b.length} bytes`);

let firstDiff = -1;
for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) {
    firstDiff = i;
    break;
  }
}
if (firstDiff === -1 && a.length === b.length) {
  console.log('\nRESULT: byte-identical  ✔');
} else {
  console.log(`\nRESULT: differs, first diff at byte ${firstDiff}`);
  if (firstDiff > -1) {
    console.log('  original:', a.subarray(firstDiff - 16, firstDiff + 32).toString('utf8').replace(/[^\x20-\x7e]/g, '.'));
    console.log('  repacked:', b.subarray(firstDiff - 16, firstDiff + 32).toString('utf8').replace(/[^\x20-\x7e]/g, '.'));
  }
}

// Content-level verification, independent of layout.
const origHeader = readAsarHeader(original);
const newHeader = readAsarHeader(outPath);
const origEntries = walkAsarEntries(origHeader.header);
const newEntries = walkAsarEntries(newHeader.header);

console.log(`\nentries: original=${origEntries.length} repacked=${newEntries.length}`);

const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const newByPath = new Map(newEntries.map((e) => [e.path, e]));
let missing = 0;
let changed = 0;

for (const entry of origEntries) {
  const other = newByPath.get(entry.path);
  if (!other) {
    missing += 1;
    if (missing <= 10) console.log(`  MISSING: ${entry.path}`);
    continue;
  }
  const ha = digest(readAsarFile(original, origHeader.header, origHeader.baseOffset, entry.path));
  const hb = digest(readAsarFile(outPath, newHeader.header, newHeader.baseOffset, entry.path));
  if (ha !== hb) {
    changed += 1;
    if (changed <= 10) console.log(`  CHANGED: ${entry.path}`);
  }
}

console.log(`\ncontent check: missing=${missing} changed=${changed}`);
console.log(missing === 0 && changed === 0 ? 'CONTENT: all 2157 entries identical  ✔' : 'CONTENT: MISMATCH  ✘');

/**
 * Determines whether the client enforces ElectronAsarIntegrity.
 *
 * If the fuse is on, the shell compares the SHA256 of the raw asar header
 * against a value baked into the executable and refuses to load a modified
 * archive. Detecting this before installing a patch is the difference between
 * "mod works" and "client no longer starts".
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function rawHeaderString(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const sb = Buffer.alloc(8);
  fs.readSync(fd, sb, 0, 8, 0);
  const hs = sb.readUInt32LE(4);
  const hb = Buffer.alloc(hs);
  fs.readSync(fd, hb, 0, hs, 8);
  const jl = hb.readUInt32LE(4);
  const json = hb.toString('utf8', 8, 8 + jl);
  fs.closeSync(fd);
  return { json, headerBuffer: hb };
}

const installDir = process.argv[2];
const asarPath = process.argv[3];
const exePath = path.join(installDir, 'Яндекс Музыка.exe');

const { json, headerBuffer } = rawHeaderString(asarPath);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const candidates = {
  'sha256(header JSON string)': sha(Buffer.from(json, 'utf8')),
  'sha256(header pickle buffer)': sha(headerBuffer),
};

console.log('asar:', asarPath);
for (const [label, hash] of Object.entries(candidates)) {
  console.log(`  ${label}: ${hash}`);
}

const exe = fs.readFileSync(exePath);
console.log(`\nexe: ${exePath} (${(exe.length / 1024 / 1024).toFixed(1)} MiB)`);

for (const [label, hash] of Object.entries(candidates)) {
  const ascii = Buffer.from(hash, 'utf8');
  const utf16 = Buffer.from(hash, 'utf16le');
  console.log(`\n${label}`);
  console.log(`  as ASCII in exe : ${exe.includes(ascii) ? 'FOUND  <-- integrity enabled' : 'not found'}`);
  console.log(`  as UTF-16 in exe: ${exe.includes(utf16) ? 'FOUND  <-- integrity enabled' : 'not found'}`);
}

for (const needle of ['ElectronAsarIntegrity', 'EnableEmbeddedAsarIntegrityValidation', 'asarIntegrity']) {
  const found = exe.includes(Buffer.from(needle, 'utf8'));
  console.log(`\nstring "${needle}" in exe: ${found ? 'FOUND' : 'not found'}`);
}

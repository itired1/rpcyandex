import fs from 'node:fs';
import path from 'node:path';
import { readAsarHeader, readAsarFile, findEntry } from './asar-lib.mjs';

const [asarPath, outDir, ...paths] = process.argv.slice(2);
if (!asarPath || !outDir || paths.length === 0) {
  console.error('usage: node asar-extract.mjs <app.asar> <outDir> <entry> [entry...]');
  process.exit(2);
}

const { header, baseOffset } = readAsarHeader(asarPath);
fs.mkdirSync(outDir, { recursive: true });

for (const p of paths) {
  const entry = findEntry(header, p);
  if (!entry) {
    console.error(`not found: ${p}`);
    continue;
  }
  if (entry.files) {
    console.error(`is a directory (not supported yet): ${p}`);
    continue;
  }
  const buf = readAsarFile(asarPath, header, baseOffset, p);
  const target = path.join(outDir, ...p.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  console.log(`extracted ${buf.length} bytes -> ${target}`);
}

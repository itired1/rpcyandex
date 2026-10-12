import fs from 'node:fs';
import path from 'node:path';
import { readAsarHeader, walkAsarEntries } from './asar-lib.mjs';

const asarPath = process.argv[2];
if (!asarPath) {
  console.error('usage: node asar-list.mjs <app.asar> [--depth N] [--grep re]');
  process.exit(2);
}

const { header } = readAsarHeader(asarPath);
const entries = walkAsarEntries(header);
const totalBytes = entries.reduce((a, e) => a + e.size, 0);

console.log(`asar: ${asarPath}`);
console.log(`entries: ${entries.length}, total: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);

const depthArg = process.argv.indexOf('--depth');
const maxDepth = depthArg > -1 ? Number(process.argv[depthArg + 1]) : Infinity;

const seen = new Set();
console.log('\n=== tree (dirs, aggregated while depth allows) ===');
for (const e of entries) {
  const parts = e.path.split('/');
  for (let d = 1; d <= Math.min(parts.length - 1, maxDepth); d += 1) {
    const dir = parts.slice(0, d).join('/') + '/';
    if (seen.has(dir)) continue;
    seen.add(dir);
    const agg = entries
      .filter((x) => x.path.startsWith(dir))
      .reduce((a, x) => a + x.size, 0);
    console.log(`${'  '.repeat(d - 1)}${parts[d - 1]}/  [${(agg / 1024).toFixed(0)} KiB]`);
  }
}

const grepArg = process.argv.indexOf('--grep');
if (grepArg > -1) {
  const re = new RegExp(process.argv[grepArg + 1], 'i');
  console.log(`\n=== files matching ${re} ===`);
  for (const e of entries.filter((x) => re.test(x.path)).slice(0, 200)) {
    console.log(`${(e.size / 1024).toFixed(1).padStart(9)} KiB  ${e.path}`);
  }
}

console.log('\n=== 40 largest files ===');
for (const e of [...entries].sort((a, b) => b.size - a.size).slice(0, 40)) {
  console.log(`${(e.size / 1024 / 1024).toFixed(2).padStart(8)} MiB  ${e.path}`);
}

const pkgIdx = entries.findIndex((e) => e.path === 'package.json');
if (pkgIdx > -1) {
  console.log('\n=== package.json size ===', entries[pkgIdx].size);
}
fs.writeFileSync(
  path.join(process.cwd(), 'recon-entries.txt'),
  entries.map((e) => `${e.size}\t${e.path}`).join('\n'),
);
console.log('\nfull list written to recon-entries.txt');

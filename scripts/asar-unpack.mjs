import path from 'node:path';
import { extractAsar } from './asar-lib.mjs';

const [asarPath, destDir, filterSrc] = process.argv.slice(2);
if (!asarPath || !destDir) {
  console.error('usage: node asar-unpack.mjs <app.asar> <destDir> [pathRegex]');
  process.exit(2);
}

const filter = filterSrc ? (p) => new RegExp(filterSrc).test(p) : undefined;
const started = Date.now();
const { count } = extractAsar(asarPath, destDir, { filter });
console.log(`unpacked ${count} files to ${destDir} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`dest: ${path.resolve(destDir)}`);

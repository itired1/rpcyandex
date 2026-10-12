import { readAsarHeader, readAsarFile } from './asar-lib.mjs';

const [asarPath, entry = 'index.js', chars = '300'] = process.argv.slice(2);
const { header, baseOffset } = readAsarHeader(asarPath);
const data = readAsarFile(asarPath, header, baseOffset, entry).toString('utf8');
console.log(`--- first ${chars} chars of ${entry} in ${asarPath} ---`);
console.log(JSON.stringify(data.slice(0, Number(chars))));
console.log('\n--- asar package.json ---');
console.log(readAsarFile(asarPath, header, baseOffset, 'package.json').toString('utf8'));

import fs from 'node:fs';

const p = process.argv[2];
const fd = fs.openSync(p, 'r');
const sb = Buffer.alloc(8);
fs.readSync(fd, sb, 0, 8, 0);
const hs = sb.readUInt32LE(4);
const hb = Buffer.alloc(hs);
fs.readSync(fd, hb, 0, hs, 8);
const jl = hb.readUInt32LE(4);
const j = hb.toString('utf8', 8, 8 + jl);
fs.closeSync(fd);

const i = j.indexOf('"offset"');
console.log('--- around first offset ---');
console.log(j.slice(Math.max(0, i - 200), i + 120));

const structural = j.match(/"(link|integrity|executable|unpacked|size|offset|files)"/g) ?? [];
const counts = structural.reduce((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
console.log('\n--- key frequency ---');
console.log(counts);
console.log('\n--- 8-byte alignment of header payload ---');
console.log('jsonLength', jl, 'mod4', jl % 4, '-> pad', (4 - ((4 + jl) % 4)) % 4);
console.log('\n--- first 3 entries raw ---');
let idx = 0;
let n = 0;
while (n < 3) {
  const k = j.indexOf('"size"', idx);
  if (k === -1) break;
  console.log(j.slice(k - 60, k + 80));
  idx = k + 6;
  n += 1;
}

import fs from 'node:fs';
import { readAsarHeader } from './asar-lib.mjs';

function rawHeaderJson(p) {
  const fd = fs.openSync(p, 'r');
  const sb = Buffer.alloc(8);
  fs.readSync(fd, sb, 0, 8, 0);
  const hs = sb.readUInt32LE(4);
  const hb = Buffer.alloc(hs);
  fs.readSync(fd, hb, 0, hs, 8);
  const jl = hb.readUInt32LE(4);
  const json = hb.toString('utf8', 8, 8 + jl);
  fs.closeSync(fd);
  return { json, hs, jl };
}

const a = rawHeaderJson(process.argv[2]);
const b = rawHeaderJson(process.argv[3]);

console.log(`original header: size=${a.hs} json=${a.jl}`);
console.log(`repacked header: size=${b.hs} json=${b.jl}`);
console.log(`delta: ${a.jl - b.jl}`);

let i = 0;
while (i < Math.min(a.json.length, b.json.length) && a.json[i] === b.json[i]) i += 1;
console.log(`\nfirst JSON diff at char ${i}`);
console.log('original:', JSON.stringify(a.json.slice(Math.max(0, i - 120), i + 260)));
console.log('\nrepacked:', JSON.stringify(b.json.slice(Math.max(0, i - 120), i + 260)));

// Which distinct keys exist on each side?
const keysOf = (json) => {
  const counts = new Map();
  for (const m of json.matchAll(/"([a-zA-Z_]+)":/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return counts;
};
const ka = keysOf(a.json);
const kb = keysOf(b.json);
console.log('\nkey counts (original vs repacked):');
for (const k of new Set([...ka.keys(), ...kb.keys()])) {
  const x = ka.get(k) ?? 0;
  const y = kb.get(k) ?? 0;
  console.log(`  ${k.padEnd(14)} ${String(x).padStart(6)} ${String(y).padStart(6)} ${x !== y ? '  <-- DIFFERS' : ''}`);
}

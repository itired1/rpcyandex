/**
 * Prints surrounding context for regex matches inside minified (single-line) bundles.
 *
 * usage: node ctx.mjs <dirOrFile> <regex> [--before 200] [--after 400] [--max 20] [--filter sub]
 */
import fs from 'node:fs';
import path from 'node:path';

const [target, pattern, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i > -1 ? Number(rest[i + 1]) : dflt;
};
const subFilter = rest.indexOf('--filter') > -1 ? rest[rest.indexOf('--filter') + 1] : null;
const before = opt('before', 200);
const after = opt('after', 400);
const max = opt('max', 20);

const re = new RegExp(pattern, 'g');

function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(p)) walk(path.join(p, entry), out);
  } else if (/\.(js|mjs|cjs|html|json)$/.test(p)) {
    out.push(p);
  }
  return out;
}

let shown = 0;
for (const file of walk(target)) {
  if (subFilter && !file.includes(subFilter)) continue;
  const text = fs.readFileSync(file, 'utf8');
  re.lastIndex = 0;
  let m;
  let count = 0;
  while ((m = re.exec(text)) !== null && count < max) {
    count += 1;
    shown += 1;
    const start = Math.max(0, m.index - before);
    const end = Math.min(text.length, m.index + m[0].length + after);
    console.log(`\n--- ${path.relative(process.cwd(), file)} @${m.index} (${count}) ---`);
    console.log(text.slice(start, end).replace(/\s+/g, ' '));
    if (m[0].length === 0) re.lastIndex += 1;
  }
}
console.log(`\n[${shown} matches shown]`);

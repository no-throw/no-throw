// PROTOTYPE — throwaway (#26). Cache the nightly HTML of every spec that ships IDL.
import * as idl from '@webref/idl';
import specs from 'web-specs' with { type: 'json' };
import fs from 'node:fs';
import path from 'node:path';

const CACHE = 'cache';
fs.mkdirSync(CACHE, { recursive: true });

// webref keys are not always web-specs shortnames (`SVG`, `IndexedDB`, `webgl1`); matching
// case-sensitively silently dropped 67 specs — 1,040 WebGL members among them.
const byShort = new Map(specs.map((s) => [s.shortname.toLowerCase(), s]));
const bySeries = new Map(specs.map((s) => [s.series.shortname.toLowerCase(), s]));
const targets = [];
const unresolved = [];
for (const key of Object.keys(await idl.listAll())) {
  const s = byShort.get(key.toLowerCase()) ?? bySeries.get(key.toLowerCase());
  if (s) targets.push({ ...s, shortname: key });
  else unresolved.push(key);
}
// The IDL-bearing corpus is not closed under "calls": a third of cross-spec links leave it,
// 10,688 of them into Infra alone, and Selectors defines the parse step that makes
// `Element.matches` throw. Same shape as #22's ECMA-402 blind spot, so take every spec.
if (process.env.CLOSED) {
  const have = new Set(targets.map((t) => t.shortname.toLowerCase()));
  for (const s of specs) if (s.standing === 'good' && !have.has(s.shortname.toLowerCase())) targets.push(s);
}
if (unresolved.length) console.log('unresolved webref keys:', unresolved.join(' '));

// WHATWG multipage URLs have no algorithms on the index page — use the single-page build.
const urlFor = (s) => (s.nightly?.url ?? s.release?.url ?? s.url).replace(/\/multipage\/?$/, '/');

let done = 0;
let bytes = 0;
const failures = [];

const work = targets.map((s) => async () => {
  const file = path.join(CACHE, `${s.shortname}.html`);
  if (fs.existsSync(file)) {
    bytes += fs.statSync(file).size;
    done++;
    return;
  }
  try {
    const res = await fetch(urlFor(s), { headers: { 'user-agent': 'no-throw-spike/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    fs.writeFileSync(file, html);
    bytes += html.length;
    done++;
  } catch (e) {
    failures.push([s.shortname, urlFor(s), String(e.message)]);
  }
});

const CONCURRENCY = 8;
const queue = [...work];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await queue.shift()();
  }),
);

fs.mkdirSync('out', { recursive: true });
fs.writeFileSync(
  'out/spec-index.json',
  JSON.stringify(
    targets.map((s) => ({
      key: s.shortname,
      urls: [...new Set([s.nightly?.url, s.release?.url, ...(s.nightly?.alternateUrls ?? []), s.url].filter(Boolean).map((u) => u.replace(/\/multipage\/?$/, '/')))],
    })),
    null,
    1,
  ),
);

console.log(`specs with IDL: ${targets.length}`);
console.log(`cached: ${done}  (${(bytes / 1e6).toFixed(1)} MB)`);
if (failures.length) {
  console.log(`failed: ${failures.length}`);
  for (const f of failures.slice(0, 15)) console.log('  ', f.join('  '));
}

// PROTOTYPE — throwaway (#26). How much of lib.dom.d.ts is IDL-backed at all?
import fs from 'node:fs';

const lib = JSON.parse(fs.readFileSync('out/lib-dom-members.json', 'utf8'));
const idl = JSON.parse(fs.readFileSync('out/idl-members.json', 'utf8'));
const includes = JSON.parse(fs.readFileSync('out/idl-includes.json', 'utf8'));

// index IDL by owner.name, flattening mixins onto every host that includes them
const byOwner = new Map();
for (const m of idl) {
  if (!byOwner.has(m.owner)) byOwner.set(m.owner, []);
  byOwner.get(m.owner).push(m);
}
const idlIndex = new Map();
const put = (owner, name, row) => {
  const k = `${owner}.${name}`;
  if (!idlIndex.has(k)) idlIndex.set(k, []);
  idlIndex.get(k).push(row);
};
for (const m of idl) put(m.owner, m.name, m);
for (const { host, mixin } of includes)
  for (const m of byOwner.get(mixin) ?? []) put(host, m.name, { ...m, viaMixin: mixin });

// lib.dom's non-colourable shapes: IDL dictionaries (plain data bags — no accessors,
// no algorithms) plus TS-only event maps / tag-name maps.
const dictNames = new Set(JSON.parse(fs.readFileSync('out/idl-dictionaries.json', 'utf8')));
const TS_ONLY = /(EventMap|TagNameMap)$/;
const notColourable = (owner) => dictNames.has(owner) || TS_ONLY.test(owner);

const matched = [];
const unmatched = [];
for (const m of lib) {
  if (m.kind === 'index' || m.kind === 'callsig' || m.kind === 'globalvar') continue;
  if (notColourable(m.owner)) continue;
  const owner = m.owner.replace(/\[\[ctor\]\]$/, '');
  const isCtorSide = m.owner.endsWith('[[ctor]]');
  let hits = [];
  if (m.owner === '[[global]]') {
    // `declare function fetch()` — a Window/WorkerGlobalScope operation
    hits = ['Window', 'WorkerGlobalScope', 'WindowOrWorkerGlobalScope', 'DedicatedWorkerGlobalScope']
      .flatMap((g) => idlIndex.get(`${g}.${m.name}`) ?? []);
  } else if (m.kind === 'constructor' || (isCtorSide && m.name === 'new')) {
    hits = idlIndex.get(`${owner}.constructor`) ?? [];
  } else if (isCtorSide) {
    hits = (idlIndex.get(`${owner}.${m.name}`) ?? []).filter((h) => h.static || h.kind === 'const');
  } else {
    hits = (idlIndex.get(`${owner}.${m.name}`) ?? []).filter((h) => !h.static);
  }
  if (hits.length) matched.push({ ...m, idl: hits[0], idlHits: hits.length });
  else unmatched.push({ ...m, tsOnlyShape: false });
}

const total = matched.length + unmatched.length;
const tally = (rows, f) => {
  const t = Object.create(null);
  for (const r of rows) t[f(r)] = (t[f(r)] ?? 0) + 1;
  return t;
};

console.log(`colourable lib.dom members: ${total}`);
console.log(`  IDL-backed:   ${matched.length} (${((matched.length / total) * 100).toFixed(1)}%)`, tally(matched, (r) => r.kind));
console.log(`  no IDL match: ${unmatched.length}`, tally(unmatched, (r) => r.kind));
const shapes = unmatched.filter((r) => r.tsOnlyShape);
console.log(`    of which TS-only shapes (Init/EventMap/…): ${shapes.length}`);
const real = unmatched.filter((r) => !r.tsOnlyShape);
console.log(`    genuinely unmatched: ${real.length}`);
console.log(
  '    top unmatched owners:',
  Object.entries(tally(real, (r) => r.owner))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `${k}(${v})`)
    .join(' '),
);

fs.writeFileSync('out/join.json', JSON.stringify({ matched, unmatched }, null, 1));

// --- the accessor question -------------------------------------------------
// Every IDL `attribute` is a getter/setter pair on the prototype. How does
// lib.dom.d.ts declare them?
const attrs = matched.filter((m) => m.idl.kind === 'attribute');
console.log(`\nIDL attributes reachable from lib.dom: ${attrs.length}`);
console.log('  declared in TS as:', tally(attrs, (r) => r.kind));

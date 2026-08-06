// PROTOTYPE — throwaway (#26). Transitive hazard sets per member, then join to lib.dom.
// #25 is normative here: carry the WHOLE hazard set, never one witness.
import fs from 'node:fs';

const graph = JSON.parse(fs.readFileSync('out/dfn-graph.json', 'utf8'));
const nodes = new Map(graph.map((n) => [n.key, n]));
const { matched } = JSON.parse(fs.readFileSync('out/join.json', 'utf8'));

// only *algorithmic* definitions carry control flow; an <dfn> for an interface or an
// element name is a noun, and propagating through it would make everything reach everything.
// Only *algorithmic* definitions carry control flow, and a member is a leaf: prose links
// `document.domain` or `attachInternals()` to point at them, not to call them. Leaving
// members in the propagating set made `document.domain` the root cause of 1,676 hazards.
const ALGORITHMIC = new Set(['dfn', 'abstract-op', undefined]);
const propagates = (n) => n && ALGORITHMIC.has(n.dfnType) && (n.isAlgorithm || n.own.length || n.callees.length);

const MAX_DEPTH = 5;
const MAX_HAZARDS = 60;

const hazardsOf = (rootKey) => {
  const root = nodes.get(rootKey);
  if (!root) return null;
  const seen = new Set([rootKey]);
  const hazards = [];
  let frontier = [{ key: rootKey, path: [] }];
  let depth = 0;
  let visited = 1;
  let truncated = false;
  while (frontier.length && depth <= MAX_DEPTH) {
    const next = [];
    for (const { key, path } of frontier) {
      const n = nodes.get(key);
      if (!n) continue;
      for (const t of n.own) {
        hazards.push({ ...t, via: path, at: n.label, atKey: n.key, depth });
        if (hazards.length >= MAX_HAZARDS) truncated = true;
      }
      if (hazards.length >= MAX_HAZARDS) break;
      for (const c of n.callees) {
        if (seen.has(c)) continue;
        const cn = nodes.get(c);
        if (!propagates(cn)) continue;
        seen.add(c);
        visited++;
        next.push({ key: c, path: [...path, cn.label] });
      }
    }
    if (hazards.length >= MAX_HAZARDS) break;
    frontier = next;
    depth++;
  }
  return { hazards, visited, truncated, depthReached: depth };
};

// index member dfns by `Interface.member`, keyed off Bikeshed's own data-lt
// (`getContext(contextId, options)|getContext(contextId)` ⇒ `getContext`)
const memberIndex = new Map();
for (const n of graph) {
  if (!['method', 'attribute', 'constructor'].includes(n.dfnType)) continue;
  const names = new Set();
  for (const alt of n.lt ?? []) names.add(alt.replace(/\(.*$/, '').trim());
  names.add(n.id.replace(/^dom-/, '').split('-').pop());
  if (n.dfnType === 'constructor') names.add('constructor');
  for (const f of n.dfnFor)
    for (const name of names) {
      if (!name) continue;
      const k = `${f}.${name.toLowerCase()}`;
      // a real algorithm beats a bare IDL restatement
      if (!memberIndex.has(k) || (n.isAlgorithm && !memberIndex.get(k).isAlgorithm)) memberIndex.set(k, n);
    }
}

let hit = 0;
let miss = 0;
const rows = [];
const visitedTally = [];
for (const m of matched) {
  const owner = m.owner.replace(/\[\[ctor\]\]$/, '');
  const idlOwner = m.idl.viaMixin ?? m.idl.owner;
  const name = m.kind === 'constructor' ? 'constructor' : m.name;
  const dfn = memberIndex.get(`${idlOwner}.${name.toLowerCase()}`) ?? memberIndex.get(`${owner}.${name.toLowerCase()}`);
  if (!dfn) {
    miss++;
    rows.push({ ...m, prose: null });
    continue;
  }
  hit++;
  const h = hazardsOf(dfn.key);
  visitedTally.push(h.visited);
  rows.push({ ...m, dfnKey: dfn.key, prose: h });
}

fs.writeFileSync('out/member-hazards.json', JSON.stringify(rows));

const withHaz = rows.filter((r) => r.prose?.hazards.length);
const clean = rows.filter((r) => r.prose && !r.prose.hazards.length);
const pct = (n) => `${((n / matched.length) * 100).toFixed(1)}%`;
visitedTally.sort((a, b) => a - b);
const median = visitedTally[Math.floor(visitedTally.length / 2)] ?? 0;

console.log(`IDL-backed lib.dom members:        ${matched.length}`);
console.log(`  member dfn found in prose:       ${hit} (${pct(hit)})`);
console.log(`  no prose algorithm:              ${miss} (${pct(miss)})`);
console.log(`    of those with prose:`);
console.log(`      hazards found (⇒ throwing):  ${withHaz.length}`);
console.log(`      no hazard reached (⇒ clean?): ${clean.length}`);
console.log(`      truncated at ${MAX_HAZARDS} hazards:      ${rows.filter((r) => r.prose?.truncated).length}`);
console.log(`\nreachability: median ${median} definitions visited per member, max ${visitedTally.at(-1)}`);
const hazCounts = withHaz.map((r) => r.prose.hazards.length).sort((a, b) => a - b);
console.log(`hazard-set size: median ${hazCounts[Math.floor(hazCounts.length / 2)]}, p90 ${hazCounts[Math.floor(hazCounts.length * 0.9)]}`);

// what do the hazards look like?
const excTally = Object.create(null);
for (const r of withHaz) for (const h of r.prose.hazards) excTally[h.exc] = (excTally[h.exc] ?? 0) + 1;
console.log(
  '\nexception kinds across all hazard sets:',
  Object.entries(excTally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `${k}:${v}`)
    .join(' '),
);

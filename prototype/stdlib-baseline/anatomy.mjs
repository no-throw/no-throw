// PROTOTYPE — throwaway. Anatomy of the review residue, for https://github.com/MidnightDesign/no-throw/issues/25
// Run: node anatomy.mjs
import { readFileSync } from "node:fs";
const { proposals } = JSON.parse(readFileSync(new URL("./out/proposals.json", import.meta.url)));
const human = proposals.filter((p) => p.group === null);

const byRoot = new Map();
const explicit = [];
const untraceable = [];
const iteration = [];
const nocallable = [];
for (const p of human)
  for (const s of p.sites) {
    if (s.verdict !== "review") continue;
    if (s.rule.startsWith("unbucketed root op")) {
      const r = s.root;
      if (!byRoot.has(r)) byRoot.set(r, { sites: 0, members: new Set(), sample: s.site.why ?? s.site.step });
      const e = byRoot.get(r);
      e.sites++;
      e.members.add(p.key);
    } else if (s.rule.startsWith("explicit throw")) explicit.push({ key: p.key, step: s.site.step });
    else if (s.rule.startsWith("coerces a value not traceable")) untraceable.push({ key: p.key, root: s.root, step: s.site.step });
    else if (s.rule.startsWith("drives a user")) iteration.push({ key: p.key, root: s.root });
    else if (s.rule.startsWith("invokes user code")) nocallable.push({ key: p.key, sig: p.signature });
    else (byRoot.has("OTHER:" + s.rule) || byRoot.set("OTHER:" + s.rule, { sites: 0, members: new Set(), sample: s.site.step })) && byRoot.get("OTHER:" + s.rule).sites++;
  }

console.log("=== unbucketed root ops (%d distinct) ===", byRoot.size);
for (const [r, e] of [...byRoot].sort((a, b) => b[1].sites - a[1].sites))
  console.log(`${String(e.sites).padStart(3)} sites ${String(e.members.size).padStart(3)} members  ${r}\n      ${String(e.sample).slice(0, 150)}`);

// members whose ONLY review sites are unbucketed root ops
const blockedOnlyByRoots = human.filter((p) =>
  p.sites.filter((s) => s.verdict === "review").every((s) => s.rule.startsWith("unbucketed root op")));
console.log("\nmembers blocked ONLY by unbucketed root ops: %d", blockedOnlyByRoots.length);

console.log("\n=== explicit-throw conditions (%d sites, %d distinct members) ===", explicit.length, new Set(explicit.map((e) => e.key)).size);
const norm = (s) => s.replace(/\b[a-z]?[A-Z][A-Za-z]*\b/g, "«V»").replace(/[-+]?\d+(\.\d+)?/g, "«N»").replace(/\s+/g, " ").trim();
const pat = new Map();
for (const e of explicit) {
  const k = norm(e.step).slice(0, 110);
  if (!pat.has(k)) pat.set(k, []);
  pat.get(k).push(e);
}
for (const [k, es] of [...pat].sort((a, b) => b[1].length - a[1].length).slice(0, 40))
  console.log(`${String(es.length).padStart(3)}  ${k}\n      e.g. ${es[0].key}: ${es[0].step.slice(0, 130)}`);

console.log("\n=== untraceable coercions (%d) ===", untraceable.length);
const ur = {};
for (const u of untraceable) ur[u.root] = (ur[u.root] ?? 0) + 1;
console.log(ur);
for (const u of untraceable.slice(0, 15)) console.log(`  ${u.key} [${u.root}] ${u.step.slice(0, 120)}`);

console.log("\n=== iteration (%d) ===", iteration.length, [...new Set(iteration.map((i) => i.key))].join(", "));
console.log("\n=== user call, no callable param (%d) ===", nocallable.length);
for (const n of nocallable) console.log(`  ${n.key}  ${String(n.sig).slice(0, 110)}`);

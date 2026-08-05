// PROTOTYPE — throwaway. Spike for https://github.com/MidnightDesign/no-throw/issues/22
//
// (a) Ecmarkup extraction: pull per-builtin throw sites out of ECMA-262's spec.html,
// resolving abstract-operation indirection transitively.
//
// Run: node extract.mjs   (expects ./spec.html, see fetch-spec.sh)
// Emits: ./out/throw-sites.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const html = readFileSync(new URL("./spec.html", import.meta.url), "utf8");

/* ------------------------------------------------------------------ */
/* 1. Clause tree                                                      */
/* ------------------------------------------------------------------ */

// Scan for <emu-clause ...> ... </emu-clause> with a nesting stack, so each
// clause knows its own extent and we can tell own-content from child-content.
function parseClauses(src) {
  const open = /<emu-clause\s+id=([^\s>]+)([^>]*)>/g;
  const tag = /<(\/?)emu-clause\b[^>]*>/g;
  const clauses = [];
  const stack = [];
  let m;
  while ((m = tag.exec(src))) {
    if (m[1] === "/") {
      const c = stack.pop();
      if (c) {
        c.end = m.index;
        c.html = src.slice(c.contentStart, c.end);
      }
      continue;
    }
    open.lastIndex = m.index;
    const om = open.exec(src);
    const attrs = om && om.index === m.index ? om[2] : "";
    const id = om && om.index === m.index ? om[1] : "?";
    const type = /type="([^"]*)"/.exec(attrs)?.[1] ?? null;
    const c = {
      id: id.replace(/"/g, ""),
      type,
      start: m.index,
      contentStart: m.index + m[0].length,
      parent: stack[stack.length - 1] ?? null,
    };
    clauses.push(c);
    stack.push(c);
  }
  return clauses;
}

const clauses = parseClauses(html);

const stripTags = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

for (const c of clauses) {
  const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(c.html ?? "");
  c.title = h1 ? stripTags(h1[1]).replace(/^[\d.]+\s*/, "") : "";
  // aoid may be declared on the clause tag itself
  const aoidAttr = /<emu-clause\s+id=[^>]*?\baoid=("?)([\w$]+)\1/.exec(
    html.slice(c.start, c.contentStart),
  );
  c.aoid = aoidAttr?.[2] ?? null;
}

// Own HTML = clause content minus nested clause content, so a parent's steps
// are not polluted by its children's.
const byStart = [...clauses].sort((a, b) => a.start - b.start);
for (const c of byStart) {
  const kids = clauses.filter((k) => k.parent === c);
  if (!kids.length) {
    c.ownHtml = c.html ?? "";
    continue;
  }
  let out = "";
  let cursor = c.contentStart;
  for (const k of kids.sort((a, b) => a.start - b.start)) {
    out += html.slice(cursor, k.start);
    cursor = k.end + "</emu-clause>".length;
  }
  out += html.slice(cursor, c.end);
  c.ownHtml = out;
}

/* ------------------------------------------------------------------ */
/* 2. Steps of an algorithm                                            */
/* ------------------------------------------------------------------ */

// Flatten the <emu-alg> <li> tree into leaf-ish steps: each step keeps its own
// inline HTML (children's markup stripped off) so a throw is attributed to the
// step that performs it.
function steps(ownHtml) {
  const algs = [...ownHtml.matchAll(/<emu-alg>([\s\S]*?)<\/emu-alg>/g)].map(
    (m) => m[1],
  );
  const out = [];
  for (const alg of algs) {
    const tag = /<(\/?)li\b[^>]*>/g;
    const stack = [];
    let m;
    while ((m = tag.exec(alg))) {
      if (m[1] === "/") {
        const li = stack.pop();
        if (!li) continue;
        li.raw = alg.slice(li.contentStart, m.index);
        continue;
      }
      const li = { contentStart: m.index + m[0].length, depth: stack.length };
      out.push(li);
      stack.push(li);
    }
  }
  // strip nested <ol>…</ol> so a step's own text excludes its sub-steps
  for (const li of out) {
    li.self = (li.raw ?? "").replace(/<ol[\s\S]*$/, "");
    li.text = stripTags(li.self);
  }
  return out.filter((li) => li.text);
}

/* ------------------------------------------------------------------ */
/* 3. Throw sites in one step                                          */
/* ------------------------------------------------------------------ */

const THROW_RE =
  /throw a(?:n)? <emu-val>(TypeError|RangeError|SyntaxError|ReferenceError|URIError|EvalError)<\/emu-val>/i;

// A `?` (or ReturnIfAbrupt) immediately before a call site propagates abruptness.
// `!` asserts never-abrupt (spec §5.2.4.3) and is deliberately NOT a throw site.
function callSites(selfHtml) {
  const sites = [];
  // ? AO(...) — aoid cross-reference
  const re = /([?!])\s*<emu-xref[^>]*\baoid=("?)([\w$𝔽ℝ]+)\2[^>]*>/g;
  let m;
  while ((m = re.exec(selfHtml)))
    sites.push({ kind: "ao", mark: m[1], name: m[3] });
  // ? x.[[Get]](...) — internal method
  const im = /([?!])\s*(?:<[^>]+>|\w|\.|\s)*?\[\[(\w+)\]\]/g;
  while ((m = im.exec(selfHtml)))
    sites.push({ kind: "internal", mark: m[1], name: `[[${m[2]}]]` });
  return sites;
}

/* ------------------------------------------------------------------ */
/* 4. Index abstract ops, then fixpoint "can this op throw?"           */
/* ------------------------------------------------------------------ */

const OP_TYPES = new Set([
  "abstract operation",
  "numeric method",
  "host-defined abstract operation",
  "implementation-defined abstract operation",
  "concrete method",
  "internal method",
]);

const ops = new Map(); // aoid -> node
for (const c of clauses) {
  if (!OP_TYPES.has(c.type ?? "")) continue;
  const name = c.aoid ?? c.title.split(/[\s(]/)[0];
  if (!name) continue;
  const node = {
    name,
    id: c.id,
    title: c.title,
    kind: c.type,
    ownThrows: [],
    calls: [],
  };
  for (const s of steps(c.ownHtml)) {
    if (THROW_RE.test(s.self))
      node.ownThrows.push({ why: s.text, error: THROW_RE.exec(s.self)[1] });
    for (const cs of callSites(s.self))
      if (cs.mark === "?") node.calls.push({ ...cs, why: s.text });
  }
  // Prose-only ops (no emu-alg): "throws a TypeError if…" in a <p>
  if (!node.ownThrows.length && THROW_RE.test(c.ownHtml) && !/<emu-alg>/.test(c.ownHtml))
    node.ownThrows.push({ why: stripTags(c.ownHtml).slice(0, 200), error: "prose" });
  if (!ops.has(name)) ops.set(name, node);
}

// Internal methods ([[Get]] etc.) are dispatched dynamically: ordinary, exotic,
// and Proxy variants all share the name. Merge all clauses that define one.
const internals = new Map();
for (const c of clauses) {
  if (c.type !== "internal method") continue;
  const m = /\[\[(\w+)\]\]/.exec(c.title);
  if (!m) continue;
  const key = `[[${m[1]}]]`;
  const node = internals.get(key) ?? { name: key, ownThrows: [], calls: [] };
  for (const s of steps(c.ownHtml)) {
    if (THROW_RE.test(s.self))
      node.ownThrows.push({ why: `${c.title}: ${s.text}`, error: THROW_RE.exec(s.self)[1] });
    for (const cs of callSites(s.self))
      if (cs.mark === "?") node.calls.push({ ...cs, why: s.text });
  }
  internals.set(key, node);
}
for (const [k, v] of internals) ops.set(k, v);

// Least fixpoint: an op can throw if it throws itself or `?`-calls one that can.
// Records a shortest witness path for the reviewer.
const canThrow = new Map();
for (const [name, op] of ops)
  if (op.ownThrows.length) canThrow.set(name, { via: [name], why: op.ownThrows[0] });

let changed = true;
while (changed) {
  changed = false;
  for (const [name, op] of ops) {
    if (canThrow.has(name)) continue;
    for (const call of op.calls) {
      const t = canThrow.get(call.name);
      if (t) {
        canThrow.set(name, { via: [name, ...t.via], why: t.why });
        changed = true;
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. Builtins                                                         */
/* ------------------------------------------------------------------ */

// The argument list of `Op(...)` inside a step's plain text, paren-matched.
function argsOf(text, op) {
  const i = text.indexOf(`${op}(`);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i + op.length; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")") {
      depth--;
      if (!depth) return text.slice(i + op.length + 1, j);
    }
  }
  return null;
}

const builtins = [];
for (const c of clauses) {
  if (c.type !== "built-in function") continue;
  const sig = c.title.replace(/\s*\[[^\]]*\]\s*/g, " ").trim();
  const name = sig.split("(")[0].trim();
  const params = /\(([^)]*)\)/.exec(c.title)?.[1] ?? "";
  const b = {
    id: c.id,
    name,
    signature: c.title,
    params: params
      .split(",")
      .map((p) => p.replace(/[[\]]/g, "").trim())
      .filter(Boolean),
    throwSites: [],
    unresolved: [],
    hasAlg: /<emu-alg>/.test(c.ownHtml),
  };
  const ss = steps(c.ownHtml);
  b.steps = ss.map((s) => s.text);
  ss.forEach((s, i) => {
    if (THROW_RE.test(s.self))
      b.throwSites.push({
        kind: "explicit",
        error: THROW_RE.exec(s.self)[1],
        step: s.text,
        stepIndex: i,
        via: [],
      });
    for (const cs of callSites(s.self)) {
      if (cs.mark !== "?") continue;
      const t = canThrow.get(cs.name);
      if (t)
        b.throwSites.push({
          kind: "propagated",
          op: cs.name,
          error: t.why.error,
          step: s.text,
          stepIndex: i,
          operand: argsOf(s.text, cs.name),
          why: t.why.why,
          via: t.via,
        });
      else if (!ops.has(cs.name)) b.unresolved.push(cs.name);
    }
  });
  builtins.push(b);
}

mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("./out/throw-sites.json", import.meta.url),
  JSON.stringify({ builtins, opCount: ops.size, throwingOps: canThrow.size }, null, 2),
);

/* ------------------------------------------------------------------ */
/* 6. Report                                                           */
/* ------------------------------------------------------------------ */

const withAlg = builtins.filter((b) => b.hasAlg);
const clean = withAlg.filter((b) => !b.throwSites.length);
const unresolved = new Set(builtins.flatMap((b) => b.unresolved));
console.log(`clauses:            ${clauses.length}`);
console.log(`abstract ops:       ${ops.size}  (can throw: ${canThrow.size})`);
console.log(`built-in functions: ${builtins.length}  (with an emu-alg: ${withAlg.length})`);
console.log(`  with >=1 throw site: ${withAlg.length - clean.length}`);
console.log(`  with zero throw sites: ${clean.length}`);
console.log(
  `throw sites total:  ${builtins.reduce((n, b) => n + b.throwSites.length, 0)}`,
);
console.log(`unresolved callees: ${unresolved.size}`, [...unresolved].slice(0, 12));
console.log(
  `\nmax depth of a witness path: ${Math.max(
    ...builtins.flatMap((b) => b.throwSites.map((t) => t.via?.length ?? 0)),
  )}`,
);
for (const n of ["Array.prototype.push", "Object.keys", "Math.max", "JSON.parse", "Array.prototype.map"]) {
  const b = builtins.find((x) => x.name === n);
  if (!b) continue;
  console.log(`\n### ${b.signature}  — ${b.throwSites.length} throw site(s)`);
  for (const t of b.throwSites.slice(0, 6))
    console.log(
      `  - ${t.kind} ${t.error}${t.op ? ` via ${t.via.join(" → ")}` : ""}\n      step: ${t.step.slice(0, 110)}\n      why:  ${(t.why ?? t.step).slice(0, 110)}`,
    );
}

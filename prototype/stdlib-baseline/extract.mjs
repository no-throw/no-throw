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
      const li = { contentStart: m.index + m[0].length, depth: stack.length, parent: stack[stack.length - 1] ?? null };
      out.push(li);
      stack.push(li);
    }
  }
  // strip nested <ol>…</ol> so a step's own text excludes its sub-steps
  for (const li of out) {
    li.self = (li.raw ?? "").replace(/<ol[\s\S]*$/, "");
    li.text = stripTags(li.self);
  }
  // A bare "Throw a TypeError exception." carries no condition — the condition is
  // the enclosing step ("If NewTarget is undefined, ... a. Throw a ..."). Without
  // the parent's text such a site is unclassifiable prose. (#25)
  for (const li of out) {
    const chain = [];
    for (let p = li.parent; p; p = p.parent) if (p.text) chain.unshift(p.text);
    li.context = chain.length ? `${chain.join(" ")} ${li.text}` : li.text;
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

// Split a captured argument list at top-level commas.
function splitArgs(text) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of text ?? "") {
    if ("(«[".includes(ch)) depth++;
    else if (")»]".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Which value an algorithm's local names ultimately came from. Shared by abstract
// ops and builtins so a root cause can be threaded back to a *caller* expression.
function origins(params, stepTexts) {
  const origin = new Map();
  (params ?? []).forEach((p, i) => origin.set(p, { kind: "param", index: i }));
  const of = (rhs) => {
    if (/this value/.test(rhs)) return { kind: "receiver" };
    for (const v of [...origin.keys()].sort((a, b) => b.length - a.length))
      if (new RegExp(`\b${v}\b`).test(rhs)) return origin.get(v);
    return { kind: "internal" };
  };
  for (const step of stepTexts ?? []) {
    let m = /^(?:Let|Set) ([\w]+) (?:be|to) (.*)$/.exec(step);
    if (m) { origin.set(m[1], of(m[2])); continue; }
    m = /^For each (?:\w+ )*?([\w]+) (?:of|in) ([\w]+)/.exec(step);
    if (m) origin.set(m[1], origin.get(m[2]) ?? { kind: "internal" });
  }
  return { origin, of };
}

// The variable a throw condition is *about*: the first name it mentions that the
// algorithm knows. "If IsCallable(func) is false, throw" → func.
function subjectOf(text, origin) {
  const names = [...origin.keys()];
  let best = null, bestAt = Infinity;
  for (const v of names) {
    const at = text.search(new RegExp(`\b${v}\b`));
    if (at >= 0 && at < bestAt) { best = v; bestAt = at; }
  }
  return best;
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
  const ss = steps(c.ownHtml);
  const node = {
    name,
    id: c.id,
    title: c.title,
    kind: c.type,
    params: (/\(([^)]*)\)/.exec(c.title)?.[1] ?? "")
      .split(",").map((p) => p.replace(/[[\]]/g, "").replace(/^\.\.\./, "").trim()).filter(Boolean),
    stepTexts: ss.map((x) => x.text),
    ownThrows: [],
    calls: [],
  };
  for (const s of ss) {
    if (THROW_RE.test(s.self))
      node.ownThrows.push({ why: s.context ?? s.text, error: THROW_RE.exec(s.self)[1] });
    for (const cs of callSites(s.self))
      if (cs.mark === "?") node.calls.push({ ...cs, why: s.text, args: splitArgs(argsOf(s.text, cs.name) ?? "") });
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
      node.ownThrows.push({ why: `${c.title}: ${s.context ?? s.text}`, error: THROW_RE.exec(s.self)[1] });
    for (const cs of callSites(s.self))
      if (cs.mark === "?") node.calls.push({ ...cs, why: s.text });
  }
  internals.set(key, node);
}
for (const [k, v] of internals) ops.set(k, v);

// Least fixpoint over `?`-edges. v2 (#25): an op carries its whole SET of root
// causes, not one witness. Collapsing to `ownThrows[0]` is not just imprecise, it
// is UNSOUND — it can hand the reviewer the one cause the declared type discharges
// and hide the one it does not (ArrayBufferCopyAndDetach reports its shared-buffer
// brand check and hides its detach check). This is #22's "sign hazards, not
// verdicts" made real in the data.
const CAP = 24;
const causes = new Map(); // opName -> Map(whyText -> {via, why, error, paramIndex})

// Per-op origin maps, so a condition's subject can be resolved to a parameter index.
const opOrigins = new Map();
for (const [name, op] of ops) opOrigins.set(name, origins(op.params, op.stepTexts));

for (const [name, op] of ops) {
  if (!op.ownThrows.length) continue;
  const { origin, of } = opOrigins.get(name);
  const m = new Map();
  for (const t of op.ownThrows) {
    if (m.has(t.why)) continue;
    const subj = subjectOf(t.why, origin);
    const o = subj ? origin.get(subj) : null;
    m.set(t.why, {
      via: [name], why: t.why, error: t.error,
      paramIndex: o?.kind === "param" ? o.index : null,
      receiver: o?.kind === "receiver",
      subject: subj,
    });
  }
  causes.set(name, m);
}

// Lift a callee's cause into the caller: if the cause is about the callee's
// parameter i, it is about whatever expression the caller passed at position i.
// That expression is then re-resolved in the CALLER's own namespace, so the chain
// ends at the builtin's declared parameter (or its receiver) — which is the only
// thing lib.d.ts can discharge. Without this the hazard set is sound but attributes
// every root cause to the wrong argument. (#25)
function lift(caller, call, cause) {
  const { origin, of } = opOrigins.get(caller.name);
  const expr = cause.paramIndex != null ? call.args?.[cause.paramIndex] : null;
  const o = expr ? of(expr) : cause.receiver ? of(call.args?.[0] ?? "") : null;
  return {
    via: [caller.name, ...cause.via],
    why: cause.why,
    error: cause.error,
    paramIndex: o?.kind === "param" ? o.index : null,
    receiver: o?.kind === "receiver",
    subject: expr ?? cause.subject,
    expr: expr ?? null,
  };
}

let changed = true;
while (changed) {
  changed = false;
  for (const [name, op] of ops) {
    const mine = causes.get(name) ?? new Map();
    const before = mine.size;
    for (const call of op.calls) {
      for (const c of (causes.get(call.name) ?? new Map()).values()) {
        if (mine.size >= CAP) break;
        if (mine.has(c.why)) continue;
        mine.set(c.why, lift(op, call, c));
      }
    }
    if (mine.size !== before) { causes.set(name, mine); changed = true; }
  }
}

const canThrow = new Map();
for (const [name, m] of causes) canThrow.set(name, [...m.values()]);

/* ------------------------------------------------------------------ */
/* 5. Builtins                                                         */
/* ------------------------------------------------------------------ */

// At a builtin's call site, resolve the root cause to the argument the builtin
// actually passed for it, falling back to the whole argument list.
function threadOperand(bo, stepText, cs, cause) {
  const all = argsOf(stepText, cs.name);
  const args = splitArgs(all ?? "");
  if (cause.paramIndex != null && args[cause.paramIndex]) return args[cause.paramIndex];
  if (cause.receiver && args[0]) return args[0];
  return all;
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
  const bo = origins(b.params, b.steps);
  ss.forEach((s, i) => {
    if (THROW_RE.test(s.self))
      b.throwSites.push({
        kind: "explicit",
        error: THROW_RE.exec(s.self)[1],
        step: s.context ?? s.text,
        stepIndex: i,
        via: [],
      });
    for (const cs of callSites(s.self)) {
      if (cs.mark !== "?") continue;
      const cz = canThrow.get(cs.name);
      if (cz)
        for (const t of cz.slice(0, 12))
          b.throwSites.push({
            kind: "propagated",
            op: cs.name,
            error: t.error,
            step: s.text,
            stepIndex: i,
            operand: threadOperand(bo, s.text, cs, t),
            why: t.why,
            via: t.via,
          });
      else if (!ops.has(cs.name)) b.unresolved.push(cs.name);
    }
  });
  builtins.push(b);
}

// Spec aliasing: "The initial value of the "toString" property is %Array.prototype.toString%".
// Such a clause has no algorithm, so it looks hazard-free while the aliased function's
// hazards apply in full. Only the hostile fuzzer surfaced this (11 counterexamples). (#25)
const byName = new Map(builtins.map((b) => [b.name, b]));
let aliased = 0;
for (const b of builtins) {
  if (b.hasAlg || b.throwSites.length) continue;
  const c = clauses.find((x) => x.id === b.id);
  const m = /initial value of the [^<]*<emu-val>"?([\w.]+)"?<\/emu-val>[^<]*(?:property|method)[^<]*is %([\w.%]+)%/.exec(c?.ownHtml ?? "");
  const target = m ? byName.get(m[2]) : null;
  if (!target?.throwSites.length) continue;
  b.aliasOf = target.name;
  b.throwSites = target.throwSites.map((t) => ({ ...t, via: [`alias→${target.name}`, ...(t.via ?? [])] }));
  b.steps = target.steps;
  aliased++;
}
console.log(`aliased clauses resolved: ${aliased}`);

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
console.log(`abstract ops:       ${ops.size}  (can throw: ${canThrow.size}, root causes tracked: ${[...canThrow.values()].reduce((n, c) => n + c.length, 0)})`);
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

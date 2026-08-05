// PROTOTYPE — throwaway. Spike for https://github.com/MidnightDesign/no-throw/issues/22
//
// Join the ecmarkup throw sites to the lib.d.ts signatures and try to classify each
// site mechanically: type-excluded (unreachable if the signature holds), type-reachable
// (a real throw), conditional on a callable parameter, or human-call.
//
// Run: node classify.mjs   Emits: ./out/proposals.json  ./out/worklist.md

import { readFileSync, writeFileSync } from "node:fs";

const { builtins } = JSON.parse(readFileSync(new URL("./out/throw-sites.json", import.meta.url)));
const libMembers = JSON.parse(readFileSync(new URL("./out/lib-members.json", import.meta.url)));

const specByName = new Map(builtins.map((b) => [b.name, b]));

/* ---- 1. Join --------------------------------------------------------- */
// The spec names getters as "get X.y"; lib.d.ts names them as plain members.
for (const b of builtins) {
  const g = /^get (.+)$/.exec(b.name);
  if (g && !specByName.has(g[1])) specByName.set(g[1], b);
}

const TYPED_ARRAYS =
  /^(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float16|Float32|Float64|BigInt64|BigUint64)Array/;
const NATIVE_ERRORS = /^(EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError)/;

// The spec writes one clause for the whole typed-array family (%TypedArray%) and one
// for all native errors (NativeError); lib.d.ts writes one per concrete constructor.
function specFor(key) {
  return (
    specByName.get(key) ??
    specByName.get(key.replace(TYPED_ARRAYS, "%TypedArray%")) ??
    specByName.get(key.replace(NATIVE_ERRORS, "NativeError")) ??
    null
  );
}

const joined = [];
const unmatchedLib = [];
for (const m of libMembers) {
  const spec = specFor(m.key);
  if (spec) joined.push({ ...m, spec });
  else unmatchedLib.push(m);
}
const matchedSpecIds = new Set(joined.map((j) => j.spec.id));
const unmatchedSpec = builtins.filter((b) => !matchedSpecIds.has(b.id));

/* ---- 2. Hazard classes ----------------------------------------------- */

const PRIMITIVE_SAFE =
  /^(number|string|boolean|bigint|void|undefined|null|number\[\]|string\[\]|readonly (number|string)\[\]|"[^"]*"|\d+)$/;

const SAFE_COERCE_TYPE = (t) => {
  const s = t.replace(/\s+/g, " ").trim().replace(/^\((.*)\)$/, "$1");
  if (PRIMITIVE_SAFE.test(s)) return true;
  // unions of safe things
  if (s.includes("|")) return s.split("|").every((p) => SAFE_COERCE_TYPE(p.trim()));
  return false;
};

// receiver hazards: unreachable when the declared receiver type holds (trust base)
const RECEIVER_COERCION = new Set(["ToObject", "RequireObjectCoercible"]);
const BRAND_CHECK = new Set([
  "RequireInternalSlot",
  "ValidateTypedArray",
  "ValidateIntegerTypedArray",
  "ValidateAtomicAccess",
  "ValidateAtomicAccessOnIntegerTypedArray",
  "ValidateNonRevokedProxy",
  "ThisNumberValue", "ThisStringValue", "ThisBigIntValue", "ThisTimeValue",
  "ThisSymbolValue", "ThisBooleanValue", "RegExpHasFlag",
]);
const COERCION = new Set([
  "ToNumber", "ToString", "ToPrimitive", "ToIntegerOrInfinity", "ToLength",
  "ToIndex", "ToBigInt", "ToNumeric", "ToPropertyKey", "ToBoolean", "ToUint32",
  "ToInt32", "StringToBigInt", "ToBigInt64", "ToBigUint64",
]);
// mutation of the receiver: a frozen/sealed object is type-conformant → real throw
const MUTATION = new Set([
  "Set", "CreateDataPropertyOrThrow", "DefinePropertyOrThrow", "DeletePropertyOrThrow",
  "SetIntegrityLevel", "CreateMethodProperty", "SetViewValue",
]);
// user code invoked through a parameter
const USER_CALL = new Set(["Call", "[[Construct]]", "GetMethod", "Construct"]);
const ITERATION = new Set([
  "IteratorNext", "IteratorClose", "IteratorStep", "IteratorStepValue", "IteratorValue",
  "GetIterator", "GetIteratorFromMethod", "IteratorToList", "AddEntriesFromIterable",
]);
// property access on the receiver: ordinary objects run accessors, Proxies run traps —
// both invisible to the type system (#14 trust base)
const PROP_ACCESS = new Set([
  "[[Get]]", "[[Set]]", "[[HasProperty]]", "[[GetOwnProperty]]", "[[OwnPropertyKeys]]",
  "[[Delete]]", "[[DefineOwnProperty]]", "[[GetPrototypeOf]]", "Get", "HasProperty",
  "LengthOfArrayLike",
]);

// Coercion ops that also range-check: the declared type never discharges these.
const VALUE_RANGE = new Set(["ToIndex", "GetViewValue", "SetViewValue", "ToBigInt64", "ToBigUint64"]);

const mentionsReceiver = (s) => /\bthis\b/.test(s);

/* ---- operand tracing --------------------------------------------------
   A throw site's operand is usually a spec-local variable several steps
   downstream of the argument that produced it ("Let obj be ? ToObject(this
   value)" … "Perform ? Set(obj, …)"). Walk the algorithm's assignments so a
   site can be attributed back to the receiver or to a declared parameter. */
function traceOrigins(spec) {
  const origin = new Map();
  const specParams = (spec.params ?? []).map((p) => p.replace(/^\.\.\./, "").trim());
  specParams.forEach((p, i) => origin.set(p, { kind: "param", index: i }));

  const rhsOrigin = (rhs) => {
    if (/\bthis value\b/.test(rhs)) return { kind: "receiver" };
    for (const [v, o] of origin) if (new RegExp(`\\b${v}\\b`).test(rhs)) return o;
    return { kind: "internal" };
  };

  for (const step of spec.steps ?? []) {
    let m = /^(?:Let|Set) ([\w]+) (?:be|to) (.*)$/.exec(step);
    if (m) {
      origin.set(m[1], rhsOrigin(m[2]));
      continue;
    }
    m = /^For each (?:\w+ )*?([\w]+) (?:of|in) ([\w]+)/.exec(step);
    if (m) origin.set(m[1], origin.get(m[2]) ?? { kind: "internal" });
  }
  return { origin, rhsOrigin };
}

// What a throw site is *about*: the receiver, a declared parameter, or engine-internal.
function operandOf(site, spec, member, traced) {
  const text = site.operand ?? site.step ?? "";
  const o = traced.rhsOrigin(text);
  if (o.kind === "param") {
    const p = member.params?.[o.index];
    return p ? { kind: "param", param: { index: o.index, ...p } } : { kind: "internal" };
  }
  return o;
}

const EXPLICIT_CALLABLE = /IsCallable\((\w+)\) is false|IsConstructor\((\w+)\) is false/;

function classifySite(site, member, traced) {
  const root = site.kind === "explicit" ? "EXPLICIT" : site.via[site.via.length - 1];
  const step = site.step ?? "";
  const operand = operandOf(site, member.spec, member, traced);
  const p = operand.kind === "param" ? operand.param : null;

  if (site.kind === "explicit") {
    if (EXPLICIT_CALLABLE.test(step)) {
      const cp = p ?? member.params?.find((x) => x.callable);
      if (cp?.callable && !cp.optional)
        return { verdict: "type-excluded", rule: "callable-param declared as a function type", root };
      return { verdict: "review", rule: "callability guard, param not clearly callable in lib.d.ts", root };
    }
    if (/is not a (String|Object|Number)|is a Symbol|is not an Object/.test(step) && p)
      return SAFE_COERCE_TYPE(p.type)
        ? { verdict: "type-excluded", rule: `guard on ${p.name}: declared ${p.type}`, root }
        : { verdict: "review", rule: `guard on ${p.name}: declared ${p.type}`, root };
    return { verdict: "review", rule: "explicit throw with a value-dependent condition", root };
  }

  if (RECEIVER_COERCION.has(root)) {
    if (operand.kind === "receiver" || mentionsReceiver(step))
      return { verdict: "type-excluded", rule: "receiver is the declaring interface (non-nullable)", root };
    if (p)
      return /\b(any|unknown)\b/.test(p.type) || /undefined|null/.test(p.type)
        ? { verdict: "type-reachable", rule: `coerces ${p.name}: declared ${p.type} admits null/undefined`, root }
        : { verdict: "type-excluded", rule: `coerces ${p.name}: declared ${p.type} is never null/undefined`, root };
    return { verdict: "review", rule: `${root} on a value not traced to receiver or parameter`, root };
  }
  if (VALUE_RANGE.has(root))
    return { verdict: "type-reachable", rule: `${root} range-checks a value the declared type does not bound`, root };
  if (BRAND_CHECK.has(root))
    return { verdict: "type-excluded", rule: "brand check discharged by the declared receiver type", root };
  if (MUTATION.has(root))
    return { verdict: "type-reachable", rule: "mutates the receiver; frozen/sealed is type-conformant", root };
  if (USER_CALL.has(root)) {
    const cp = p?.callable ? p : member.params?.find((x) => x.callable);
    if (cp) return { verdict: "conditional", rule: `runs parameter ${cp.name}`, param: cp.name, root };
    return { verdict: "review", rule: "invokes user code with no callable parameter in the signature", root };
  }
  if (ITERATION.has(root))
    return { verdict: "review", rule: "drives a user-supplied iterator", root };
  if (COERCION.has(root)) {
    if (p)
      return SAFE_COERCE_TYPE(p.type)
        ? { verdict: "type-excluded", rule: `coerces ${p.name}: declared ${p.type}`, root }
        : { verdict: "type-reachable", rule: `coerces ${p.name}: declared ${p.type} admits Symbol/BigInt/objects`, root };
    return { verdict: "review", rule: "coerces a value not traceable to a declared parameter", root };
  }
  if (PROP_ACCESS.has(root))
    return { verdict: "trust-base", rule: "property access: accessors / Proxy traps are invisible to the type system", root };
  return { verdict: "review", rule: `unbucketed root op ${root}`, root };
}

/* ---- 3. Per-member verdict ------------------------------------------- */

const RANK = { "type-reachable": 4, review: 3, conditional: 2, "trust-base": 1, "type-excluded": 0 };

const proposals = joined.map((m) => {
  const traced = traceOrigins(m.spec);
  const sites = m.spec.throwSites.map((s) => ({ ...classifySite(s, m, traced), site: s }));
  const worst = sites.reduce((a, s) => (RANK[s.verdict] > RANK[a] ? s.verdict : a), "type-excluded");
  const group =
    worst === "type-reachable" ? 2
      : worst === "review" ? null
        : worst === "conditional" ? 3
          : 1;
  return {
    key: m.key,
    libs: m.libs,
    params: m.params,
    signature: m.text,
    specSignature: m.spec.signature,
    siteCount: sites.length,
    reviewSites: sites.filter((s) => s.verdict === "review").length,
    group,
    worst,
    sites,
  };
});

/* ---- 4. Report -------------------------------------------------------- */

const tally = {};
for (const p of proposals) tally[p.worst] = (tally[p.worst] ?? 0) + 1;

const auto = proposals.filter((p) => p.group !== null);
const human = proposals.filter((p) => p.group === null);
const g = (n) => proposals.filter((p) => p.group === n).length;

console.log(`lib.d.ts members:        ${libMembers.length}`);
console.log(`spec built-in functions: ${builtins.length}`);
console.log(`joined (member ↔ spec):  ${joined.length}`);
console.log(`  lib members with no spec clause:  ${unmatchedLib.length}  (dom / TS-only / non-function)`);
console.log(`  spec clauses with no lib member:  ${unmatchedSpec.length}`);
console.log("");
console.log(`auto-classified (no review site): ${auto.length}/${joined.length} = ${((auto.length / joined.length) * 100).toFixed(0)}%`);
console.log(`  group 1 (non-throwing):  ${g(1)}`);
console.log(`  group 2 (throwing):      ${g(2)}`);
console.log(`  group 3 (conditional):   ${g(3)}`);
console.log(`needs a human call:        ${human.length}`);
console.log(`  review sites to read:    ${human.reduce((n, p) => n + p.reviewSites, 0)} (of ${proposals.reduce((n, p) => n + p.siteCount, 0)} sites total)`);
console.log("");
const reviewRules = {};
for (const p of human) for (const s of p.sites) if (s.verdict === "review") reviewRules[s.rule] = (reviewRules[s.rule] ?? 0) + 1;
console.log("what the human is asked to adjudicate:");
for (const [r, n] of Object.entries(reviewRules).sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`  ${String(n).padStart(4)}  ${r}`);

writeFileSync(new URL("./out/proposals.json", import.meta.url), JSON.stringify({ proposals, unmatchedSpec: unmatchedSpec.map((b) => b.name), unmatchedLib: unmatchedLib.map((m) => m.key) }, null, 2));

// The worklist a reviewer would actually sign.
const md = [
  "# Generated stdlib baseline worklist (PROTOTYPE)",
  "",
  `${auto.length} auto-classified, ${human.length} needing a human call. Every entry is a *proposal*; nothing here is signed.`,
  "",
];
for (const p of proposals.slice().sort((a, b) => a.key.localeCompare(b.key))) {
  md.push(`## \`${p.key}\` — ${p.group ? `proposed group ${p.group}` : "**REVIEW**"}`);
  md.push(`- lib: ${p.libs.join(", ")} · spec: \`${p.specSignature}\``);
  for (const s of p.sites)
    md.push(`- [${s.verdict}] ${s.rule}\n  - site: ${s.site.step.slice(0, 160)}\n  - why: ${(s.site.why ?? s.site.step).slice(0, 160)}`);
  md.push("");
}
writeFileSync(new URL("./out/worklist.md", import.meta.url), md.join("\n"));

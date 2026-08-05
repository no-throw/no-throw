// PROTOTYPE — throwaway. Spike for https://github.com/MidnightDesign/no-throw/issues/25
//
// classify.mjs v2. Three changes, each aimed at the review residue:
//
//   1. Hazards are keyed on the *shape of the throw condition* (prose), not on the
//      root abstract-op's NAME. The op-name enum was a treadmill (34 unbucketed ops
//      left) and a soundness hazard (a misfiled name ships a wrong verdict — the
//      Atomics bug). The conditions themselves fall into ~14 shapes.
//   2. The operand tracer knows the receiver has a declared type too (v1 dropped
//      every receiver-origin coercion to review: 54 sites).
//   3. The genuine trust-base questions are lifted out as named DOCTRINE DIALS with
//      a default and a measured cost, instead of hiding inside per-member judgment.
//
// Run: node classify2.mjs [--dial name=value ...]  Emits: ./out/proposals2.json

import { readFileSync, writeFileSync } from "node:fs";

const { builtins } = JSON.parse(readFileSync(new URL("./out/throw-sites.json", import.meta.url)));
const libMembers = JSON.parse(readFileSync(new URL("./out/lib-members.json", import.meta.url)));

/* ---- doctrine dials ---------------------------------------------------
   Each is a trust-base question #14 left open: is this hazard reachable by
   code that does NOT lie to the type system? "hazard" = it throws (sound,
   imprecise). "trust-base" = we hold it against the type system's model, the
   same class as Proxy/`as` (precise, and the guarantee is relative to it).
   Defaults are the standing-steer-3 answer: when in doubt, it throws.        */
const DIALS = {
  detachedBuffer: "hazard",   // ArrayBuffer detach / resizable shrink under a live view
  subclassHooks: "hazard",    // constructor[Symbol.species], and `this` as a constructor on a static/ctor
  proxyTraps: "trust-base",   // [[Get]]/[[OwnPropertyKeys]] refusing or throwing
  nullPrototype: "hazard",    // Object.create(null) as a receiver typed `object`
  memberCallable: "hazard",   // a *method of* a declared object param (Symbol.iterator, SetLike.has)
};
for (const a of process.argv.slice(2)) {
  const m = /^--dial(?:=|\s+)?(\w+)=(\S+)$/.exec(a) ?? /^(\w+)=(\S+)$/.exec(a);
  if (m && m[1] in DIALS) DIALS[m[1]] = m[2];
}

/* ---- 1. Join (unchanged from v1) -------------------------------------- */
const specByName = new Map(builtins.map((b) => [b.name, b]));
for (const b of builtins) {
  const g = /^get (.+)$/.exec(b.name);
  if (g && !specByName.has(g[1])) specByName.set(g[1], b);
}
const TYPED_ARRAYS =
  /^(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float16|Float32|Float64|BigInt64|BigUint64)Array/;
const NATIVE_ERRORS = /^(EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError)/;
const specFor = (key) =>
  specByName.get(key) ??
  specByName.get(key.replace(TYPED_ARRAYS, "%TypedArray%")) ??
  specByName.get(key.replace(NATIVE_ERRORS, "NativeError")) ??
  null;

const joined = [];
for (const m of libMembers) {
  const spec = specFor(m.key);
  if (spec) joined.push({ ...m, spec });
}

/* ---- 2. Declared-type domain tests ------------------------------------ */

const norm = (t) => (t ?? "").replace(/\s+/g, " ").trim().replace(/^\((.*)\)$/, "$1");
const parts = (t) => {
  const s = norm(t);
  return s.includes("|") && !/[<(]/.test(s.split("|")[0]) ? s.split("|").map((x) => x.trim()) : [s];
};
const anyOrUnknown = (t) => /^(any|unknown)$/.test(norm(t));
const nullish = (t) => parts(t).some((p) => /^(undefined|null|void)$/.test(p)) || anyOrUnknown(t);

const PRIM_SAFE = /^(number|string|boolean|void|undefined|null|"[^"]*"|-?\d+(\.\d+)?|`[^`]*`)$/;
// Safe to ToNumber/ToString/ToPrimitive: no Symbol, no BigInt, no object with a
// hostile valueOf. Arrays/objects reach user code through toString → not safe.
const coercionSafe = (t) => parts(t).every((p) => PRIM_SAFE.test(p));

// The declared type guarantees an Object (so "x is not an Object" is unreachable).
const isObjectType = (t) => {
  const ps = parts(t);
  if (!ps.length || anyOrUnknown(t)) return false;
  return ps.every((p) =>
    /^(object|Function|\{.*\}|.*\[\]|readonly .*\[\]|\(.*\)\s*=>.*|new \(.*\)\s*=>.*)$/.test(p) ||
    /^[A-Z]\w*(<.*>)?$/.test(p),          // a named interface/class type
  );
};
const isCallableType = (t) =>
  parts(t).every((p) => /=>/.test(p) || /^Function$/.test(p)) && !anyOrUnknown(t);
const isConstructorType = (t) => parts(t).every((p) => /^new \(|^\{\s*new /.test(p));
const isStringType = (t) => parts(t).every((p) => /^(string|"[^"]*"|`.*`)$/.test(p));
const isNumberType = (t) => parts(t).every((p) => /^(number|-?\d+(\.\d+)?)$/.test(p));
const isSymbolType = (t) => parts(t).every((p) => /^symbol$/.test(p));

// A primitive value carries no user code: its prototype is a builtin, and
// monkey-patching String.prototype is trust base (#14), not a reachable hazard.
// So every object-shaped hazard (accessors, species, toPrimitive, Proxy traps,
// invoked methods) is *unreachable* when the operand is declared primitive.
const isPrimitiveType = (t) =>
  parts(t).every((p) => /^(number|string|boolean|bigint|symbol|"[^"]*"|-?\d+(\.\d+)?|String|Number|Boolean|BigInt|Symbol)$/.test(p));

// `...values: number[]` and `for each x of arr` are about the ELEMENT, not the array.
const elementType = (t) => {
  const m = /^(?:readonly )?(.+)\[\]$/.exec(norm(t)) ?? /^(?:Readonly)?Array<(.+)>$/.exec(norm(t));
  return m ? m[1] : null;
};

/* ---- 3. Operand tracing (v2: the receiver is an operand too) ---------- */

function traceOrigins(spec) {
  const origin = new Map();
  const specParams = (spec.params ?? []).map((p) => p.replace(/^\.\.\./, "").trim());
  specParams.forEach((p, i) => origin.set(p, { kind: "param", index: i, via: p }));

  const rhsOrigin = (rhs) => {
    if (/\bthis value\b/.test(rhs)) return { kind: "receiver" };
    // longest variable name first: `taRecord` must beat `ta`
    const names = [...origin.keys()].sort((a, b) => b.length - a.length);
    for (const v of names) if (new RegExp(`\\b${v}\\b`).test(rhs)) return origin.get(v);
    return { kind: "internal" };
  };

  for (const step of spec.steps ?? []) {
    let m = /^(?:Let|Set) ([\w]+) (?:be|to) (.*)$/.exec(step);
    if (m) { origin.set(m[1], rhsOrigin(m[2])); continue; }
    m = /^For each (?:\w+ )*?([\w]+) (?:of|in) ([\w]+)/.exec(step);
    if (m) origin.set(m[1], origin.get(m[2]) ?? { kind: "internal" });
  }
  return { origin, rhsOrigin };
}

// Split `f(a, b, « c »)`'s captured argument text at top-level commas: the throw
// condition names a callee-local, so the caller's operand is resolved argument by
// argument, in order — the *first* one that traces to a real declared value wins.
function argList(text) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of text ?? "") {
    if ("(«[".includes(ch)) depth++;
    else if (")»]".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function resolveOperand(site, traced) {
  const args = argList(site.operand ?? "");
  for (const a of args) {
    const o = traced.rhsOrigin(a);
    if (o.kind !== "internal") return o;
  }
  return args.length ? { kind: "internal" } : traced.rhsOrigin(site.step ?? "");
}

// The declared type standing behind a traced operand.
function operandType(o, member) {
  if (o.kind === "receiver") {
    // A static's `this` is the constructor namespace itself — statically known,
    // but reachable by a subclass, so it belongs to the subclass-hook dial.
    if (member.static || member.kind === "constructor")
      return { what: "static-receiver", name: "this", type: `${member.owner}Constructor` };
    return { what: "receiver", name: "this", type: member.owner };
  }
  if (o.kind === "param") {
    const p = member.params?.[o.index];
    if (!p) return null;
    // a rest parameter's hazards are about its elements
    const el = p.rest ? elementType(p.type) : null;
    return { what: "param", name: p.name, type: el ?? p.type, param: p };
  }
  return null;
}

/* ---- 4. Condition-shape grammar --------------------------------------
   One rule per SHAPE of throw condition. `domain` names what the declared
   type must guarantee for the condition to be unreachable.                */

const SHAPES = [
  // --- reaches user code -------------------------------------------------
  { id: "species",   re: /\bSpeciesConstructor|ArraySpeciesCreate|TypedArraySpeciesCreate|TypedArrayCreateFromConstructor\b/, on: "root" },
  { id: "iterator",  re: /^(GetIterator|GetIteratorFromMethod|IteratorNext|IteratorStep|IteratorStepValue|IteratorValue|IteratorClose|IteratorToList|AddEntriesFromIterable|CreateListFromArrayLike|GetSetRecord|CreateDisposableResource)$/, on: "root" },
  { id: "usercall",  re: /^(Call|Construct|\[\[Construct\]\]|GetMethod|FindViaPredicate|GroupBy)$/, on: "root" },
  { id: "proxy",     re: /^(\[\[Get\]\]|\[\[Set\]\]|\[\[HasProperty\]\]|\[\[GetOwnProperty\]\]|\[\[OwnPropertyKeys\]\]|\[\[Delete\]\]|\[\[DefineOwnProperty\]\]|\[\[GetPrototypeOf\]\]|\[\[PreventExtensions\]\]|\[\[IsExtensible\]\]|Get|HasProperty|LengthOfArrayLike|OrdinaryHasInstance|RegExpExec)$/, on: "root" },

  // --- buffer state ------------------------------------------------------
  { id: "detach",    re: /IsDetachedBuffer|IsTypedArrayOutOfBounds|IsViewOutOfBounds|IsArrayBufferViewOutOfBounds|is detached|ArrayBufferCopyAndDetach|arrayBuffer.*detached/i },

  // --- guards discharged (or not) by a declared type ---------------------
  { id: "callable",  re: /IsCallable\((\w+)\) is false/,  domain: "callable" },
  { id: "ctor",      re: /IsConstructor\((\w+)\) is false/, domain: "constructor" },
  { id: "newtarget", re: /NewTarget is (not )?undefined/ },
  { id: "nullish",   re: /is either undefined or null|RequireObjectCoercible/, domain: "non-nullish" },
  { id: "symbolic",  re: /is a Symbol\b|is either a Symbol or a BigInt|is a BigInt\b/, domain: "coercible" },
  { id: "notObject", re: /is not an Object\b|is not an object\b/, domain: "object" },
  { id: "notString", re: /is not a String\b/, domain: "string" },
  { id: "notSymbol", re: /is not a Symbol\b/, domain: "symbol" },
  { id: "weakly",    re: /CanBeHeldWeakly\((\w+)\) is false/, domain: "object" },
  { id: "shared",    re: /IsSharedArrayBuffer\((\w+)\) is (true|false)/, domain: "buffer-kind" },
  { id: "brand",     re: /RequireInternalSlot|does not have an? \[\[|Validate(TypedArray|IntegerTypedArray|NonRevokedProxy)\b|This(Number|String|BigInt|Time|Symbol|Boolean)Value|IsPromise\((\w+)\) is false|IsRegExp/, domain: "brand" },

  { id: "isRegExp",  re: /isRegexp is true|IsRegExp\((\w+)\)/, domain: "string" },
  { id: "enumVal",   re: /is not one of "/ },

  // --- values the declared type does not bound ---------------------------
  { id: "range",     re: /\b(is|are) not in the inclusive interval|[<>≥≤] *[-+]?\d|IsValidIntegerIndex|ToIndex|GetViewValue|SetViewValue|ValidateAtomicAccess|RevalidateAtomicAccess|is not an integral Number|is not finite|is NaN\b|SameValueZero\(|cannot be represented|2(32|53|53 - 1)\b|\bnumberIndex\b/ },
  { id: "parse",     re: /is not a valid JSON text|List of errors|throw a SyntaxError|SyntaxError exception|URIError|contains any code unit other than|Decode|Encode|RegExpInitialize|CreateDynamicFunction|PerformEval|ParseJSON/i },
  { id: "state",     re: /is disposed|initialValue is not present|kPresent is false|status is false|is not present\b|already|revoked|is empty\b/ },
  { id: "mutation",  re: /^(Set|CreateDataPropertyOrThrow|DefinePropertyOrThrow|DeletePropertyOrThrow|SetIntegrityLevel|CreateMethodProperty|ArrayCreate|FlattenIntoArray|ArraySetLength)$/, on: "root" },
  { id: "coerce",    re: /^(ToNumber|ToString|ToPrimitive|ToIntegerOrInfinity|ToLength|ToNumeric|ToPropertyKey|ToBigInt|StringToBigInt|ToUint32|ToInt32|NumberToBigInt|OrdinaryToPrimitive)$/, on: "root", domain: "coercible" },
  { id: "toObject",  re: /^(ToObject|RequireObjectCoercible)$/, on: "root", domain: "non-nullish" },
];

function shapeOf(site) {
  const root = site.kind === "explicit" ? "EXPLICIT" : (site.via?.[site.via.length - 1] ?? site.op);
  const cond = site.kind === "explicit" ? site.step : (site.why ?? site.step ?? "");
  for (const s of SHAPES) {
    const subject = s.on === "root" ? root : cond;
    if (s.re.test(subject)) return { ...s, root, cond };
    // op-name rules also fire when the condition prose names the op
    if (s.on === "root" && s.re.test(root)) return { ...s, root, cond };
  }
  // second pass: a root-keyed rule may still describe an explicit site's op
  for (const s of SHAPES) if (s.on !== "root" && s.re.test(root)) return { ...s, root, cond };
  return { id: "unknown", root, cond };
}

function domainHolds(domain, ot) {
  if (!ot) return false;
  const t = ot.type;
  switch (domain) {
    case "callable": return isCallableType(t);
    case "constructor": return isConstructorType(t) || isCallableType(t);
    case "non-nullish": return ot.what === "receiver" ? true : !nullish(t) && !(ot.param?.optional);
    case "coercible": return ot.what === "receiver" ? /^(String|Number|Boolean|BigInt)$/.test(t) : coercionSafe(t);
    case "object": return ot.what === "receiver" ? true : isObjectType(t);
    case "string": return ot.what === "receiver" ? t === "String" : isStringType(t);
    case "symbol": return ot.what === "receiver" ? t === "Symbol" : isSymbolType(t);
    case "brand": return ot.what === "receiver";   // the declaring interface *is* the brand
    case "buffer-kind": return ot.what === "receiver"; // ArrayBuffer vs SharedArrayBuffer are distinct declared types
    default: return false;
  }
}

const DIAL_VERDICT = (dial) => (DIALS[dial] === "trust-base" ? "trust-base" : "type-reachable");

// ECMA-402 is a *different specification document*: ECMA-262 defers to it in prose,
// so its validation is structurally invisible to this corpus. That is a coverage
// boundary, not a judgment call — the whole family floors. (#22 finding 2)
const INTL_DEFERRED = /^(toLocale|localeCompare$)/;

function classifySite(site, member, traced) {
  const sh = shapeOf(site);
  const o = resolveOperand(site, traced);
  const ot = operandType(o, member);
  const where = ot ? `${ot.what} ${ot.name}: ${ot.type}` : "an engine-internal value";
  const V = (verdict, rule, extra = {}) => ({ verdict, rule, shape: sh.id, root: sh.root, dial: extra.dial, param: extra.param });

  // Object-shaped hazards on a declared-primitive operand are unreachable.
  const OBJECT_SHAPED = new Set(["usercall", "iterator", "species", "proxy", "detach", "mutation", "notObject", "brand"]);
  if (ot && isPrimitiveType(ot.type) && OBJECT_SHAPED.has(sh.id))
    return V("type-excluded", `${sh.id} needs an object; ${where} is primitive`);

  switch (sh.id) {
    case "usercall": {
      const cp = ot?.param?.callable ? ot.param : member.params?.find((x) => x.callable);
      if (cp) return V("conditional", `runs callable parameter ${cp.name}`, { param: cp.name });
      if (ot?.what === "receiver")
        return V(DIAL_VERDICT("nullPrototype"), "invokes a method off the receiver's prototype chain (Object.create(null) is type-conformant)", { dial: "nullPrototype" });
      return V(DIAL_VERDICT("memberCallable"), "invokes a method reached through a declared object value", { dial: "memberCallable" });
    }
    case "iterator":
      return V(DIAL_VERDICT("memberCallable"), "drives a user-supplied iterator / set-like protocol", { dial: "memberCallable" });
    case "species":
      return V(DIAL_VERDICT("subclassHooks"), "runs constructor[Symbol.species] (user code)", { dial: "subclassHooks" });
    case "proxy":
      return V(DIAL_VERDICT("proxyTraps"), "property access: accessors / Proxy traps are invisible to the type system", { dial: "proxyTraps" });
    case "detach":
      return V(DIAL_VERDICT("detachedBuffer"), "detached / out-of-bounds buffer is type-conformant", { dial: "detachedBuffer" });
    case "newtarget":
      return V("type-excluded", "call-vs-construct fixed by the declaration");
    case "range":
      return V("type-reachable", `range check on ${where}; number does not bound it`);
    case "enumVal":
      return V("type-reachable", `enumerated-value check on ${where}; the declared type is wider than the enum`);
    case "parse":
      return V("type-reachable", "parses a string; text validity is not a type");
    case "state":
      return V("type-reachable", `value/state dependent (${sh.cond.slice(0, 60)})`);
    case "mutation":
      return V("type-reachable", "mutates a receiver; frozen/sealed is type-conformant");
    case "unknown":
      return V("review", `unbucketed condition shape: ${sh.cond.slice(0, 90)}`);
    default: {
      if (!sh.domain) return V("review", `no domain test for shape ${sh.id}`);
      if (!ot) return V("review", `${sh.id} on ${where}`);
      // A guard on the constructor reached through `this`: only a subclass can fail it.
      if (ot.what === "static-receiver")
        return V(DIAL_VERDICT("subclassHooks"), `${sh.id} on the constructor reached via \`this\` (subclass hook)`, { dial: "subclassHooks" });
      return domainHolds(sh.domain, ot)
        ? V("type-excluded", `${sh.id} discharged by ${where}`)
        : V("type-reachable", `${sh.id} not discharged by ${where}`);
    }
  }
}

/* ---- 5. Per-member verdict -------------------------------------------- */

const RANK = { "type-reachable": 4, review: 3, conditional: 2, "trust-base": 1, "type-excluded": 0 };

const proposals = joined.map((m) => {
  const traced = traceOrigins(m.spec);
  const sites = m.spec.throwSites.map((s) => ({ ...classifySite(s, m, traced), site: s }));
  if (INTL_DEFERRED.test(m.name))
    sites.push({
      verdict: "type-reachable", shape: "intl", root: "ECMA-402",
      rule: "validation lives in ECMA-402, outside the extraction corpus",
      site: { step: "(no ECMA-262 algorithm covers the locale arguments)", via: [] },
    });
  const worst = sites.reduce((a, s) => (RANK[s.verdict] > RANK[a] ? s.verdict : a), "type-excluded");
  const group = worst === "type-reachable" ? 2 : worst === "review" ? null : worst === "conditional" ? 3 : 1;
  return {
    key: m.key, libs: m.libs, params: m.params, signature: m.text,
    siteCount: sites.length,
    reviewSites: sites.filter((s) => s.verdict === "review").length,
    dials: [...new Set(sites.map((s) => s.dial).filter(Boolean))],
    group, worst, sites,
  };
});

/* ---- 6. Report --------------------------------------------------------- */

const human = proposals.filter((p) => p.group === null);
const g = (n) => proposals.filter((p) => p.group === n).length;
const pct = (n) => `${((n / joined.length) * 100).toFixed(0)}%`;

if (!process.env.QUIET) {
  console.log(`dials: ${Object.entries(DIALS).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`joined members: ${joined.length}`);
  console.log(`auto-classified: ${joined.length - human.length}/${joined.length} = ${pct(joined.length - human.length)}`);
  console.log(`  group 1 (non-throwing): ${g(1)}`);
  console.log(`  group 2 (throwing):     ${g(2)}`);
  console.log(`  group 3 (conditional):  ${g(3)}`);
  console.log(`needs a human call:       ${human.length}   (${human.reduce((n, p) => n + p.reviewSites, 0)} review sites)`);
  const rules = {};
  for (const p of human) for (const s of p.sites) if (s.verdict === "review") rules[s.rule] = (rules[s.rule] ?? 0) + 1;
  for (const [r, n] of Object.entries(rules).sort((a, b) => b[1] - a[1]).slice(0, 15))
    console.log(`  ${String(n).padStart(4)}  ${r}`);
}

writeFileSync(new URL("./out/proposals2.json", import.meta.url), JSON.stringify({ dials: DIALS, proposals }, null, 2));

export { proposals, joined, DIALS };

// PROTOTYPE — throwaway. Spike for https://github.com/MidnightDesign/no-throw/issues/22
//
// (b) Type-conformant fuzzing: drive each lib.d.ts signature with values that conform
// to the *declared* types and record observed throws. An observed throw is a hard
// counterexample to a "type-excluded" verdict; silence is only weak evidence.
//
// Run: node fuzz.mjs   Emits: ./out/fuzz.json

import { readFileSync, writeFileSync } from "node:fs";

const { proposals } = JSON.parse(readFileSync(new URL("./out/proposals.json", import.meta.url)));

/* ---- receivers: type-conformant, including the awkward ones ------------ */
const frozenArr = Object.freeze([1, 2, 3]);
const sealedArr = Object.seal([1, 2, 3]);
const holey = [1, , 3];
const getterArr = (() => {
  const a = [1, 2, 3];
  Object.defineProperty(a, 1, { get: () => { throw new Error("accessor"); }, configurable: true });
  return a;
})();

const RECEIVERS = {
  Array: [[], [1, 2, 3], ["a", "b"], frozenArr, sealedArr, holey, getterArr, new Array(3)],
  String: ["", "abc", "a,b,c", "\u{1F600}", "0"],
  Number: [0, -1, 1.5, NaN, Infinity, 2 ** 53],
  Boolean: [true, false],
  BigInt: [1n, -5n],
  Symbol: [Symbol("s")],
  Object: [{}, { a: 1 }, Object.freeze({ a: 1 }), Object.create(null)],
  Function: [function f(a, b) { return a; }, () => 1],
  Date: [new Date(0), new Date(NaN)],
  RegExp: [/a/g, /(?<x>b)/u],
  Map: [new Map(), new Map([[1, 2]])],
  Set: [new Set(), new Set([1, 2])],
  WeakMap: [new WeakMap()],
  WeakSet: [new WeakSet()],
  Promise: [Promise.resolve(1)],
  ArrayBuffer: [new ArrayBuffer(8)],
  SharedArrayBuffer: typeof SharedArrayBuffer === "function" ? [new SharedArrayBuffer(8)] : [],
  DataView: [new DataView(new ArrayBuffer(8))],
  Error: [new Error("e")],
  JSON: [JSON],
  Math: [Math],
  Reflect: [Reflect],
  globalThis: [globalThis],
};
for (const TA of ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"])
  RECEIVERS[TA] = globalThis[TA] ? [new globalThis[TA](4)] : [];

/* ---- argument pools by declared type ----------------------------------- */
const NASTY_NUM = [0, 1, -1, 2.5, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 31)];
const NASTY_STR = ["", "a", "0", "not json", "{}", "\\", "["];
const ANY_POOL = [undefined, null, 0, "", {}, [], Symbol("s"), 1n, () => 1, Object.freeze({})];

// Types the generator cannot model conformantly — members using them are *skipped*
// rather than fuzzed with junk, so a "no throw observed" result stays honest.
// A union is modelled only if every member is; anything else is a skip, not a guess.
const ATOM =
  /^(number|string|boolean|bigint|symbol|any|unknown|object|undefined|null|void|(readonly )?(number|string|boolean|any)\[\]|PropertyKey|RegExp|Date|Function|T|U|V|K|E|S|"[^"]*"|\d+|\(.*\)\s*=>.*|(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64|BigInt64|BigUint64)Array(<[^>]*>)?)$/;

const modelled = (type) => {
  const t = (type ?? "any").replace(/\s+/g, " ").trim();
  const parts = splitUnion(t);
  if (parts.length > 1) return parts.every(modelled);
  return ATOM.test(t);
};

// split on top-level `|` only (so `Foo<A|B>` stays intact)
function splitUnion(t) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of t) {
    if (ch === "<" || ch === "(" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "}") depth--;
    if (ch === "|" && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function poolFor(type) {
  const t = (type ?? "any").replace(/\s+/g, " ").trim();
  // unions first — "string | string[]" must not be read as an array type
  const parts = splitUnion(t);
  if (parts.length > 1) return parts.flatMap((p) => poolFor(p)).slice(0, 8);
  if (/^(readonly )?string\[\]$/.test(t)) return [["en-US"], [], ["a"]];
  if (/^(readonly )?number\[\]$/.test(t)) return [[1, 2], []];
  if (/^number$/.test(t)) return NASTY_NUM;
  if (/^string$/.test(t)) return NASTY_STR;
  if (/^boolean$/.test(t)) return [true, false];
  if (/^bigint$/.test(t)) return [1n, 0n];
  if (/^(any|unknown)$/.test(t)) return ANY_POOL;
  if (/^object$/.test(t)) return [{}, Object.freeze({}), [], Object.create(null)];
  if (/=>/.test(t) || /^Function$/.test(t)) return [() => 1, function (a) { return a; }];
  if (/\[\]$/.test(t)) return [[]]; // element type unknown → only the empty array is certainly conformant
  if (/^(T|U|V|K|E|S)$/.test(t)) return [1, "a", {}];
  if (/^"(.*)"$/.test(t)) return [t.slice(1, -1)];
  if (/^(undefined|void)$/.test(t)) return [undefined];
  if (/^null$/.test(t)) return [null];
  if (/^symbol$/.test(t)) return [Symbol("s")];
  { const parts = splitUnion(t); if (parts.length > 1) return parts.flatMap((p) => poolFor(p)).slice(0, 8); }
  const ta = /^(\w+Array)(<.*>)?$/.exec(t);
  if (ta && globalThis[ta[1]]) return [new globalThis[ta[1]](4)];
  if (/^RegExp$/.test(t)) return [/a/, /b/g];
  if (/^Date$/.test(t)) return [new Date(0)];
  if (/^PropertyKey$/.test(t)) return ["a", 0, Symbol("k")];
  return []; // unmodelled — caller skips the member
}

const sample = (arr, n) => arr.slice(0, n);

/* ---- run --------------------------------------------------------------- */
const MAX_CALLS = 60;
const results = [];
const skipped = [];

for (const p of proposals) {
  const [owner, ...rest] = p.key.split(".");
  const isProto = p.key.includes(".prototype");
  const memberName = p.key.split(".").pop();
  const recvPool = RECEIVERS[owner] ?? [];
  const holder = isProto ? globalThis[owner]?.prototype : globalThis[owner];
  if (!holder) continue;
  let fn;
  try {
    fn = holder[memberName];
  } catch {
    continue;
  }
  if (typeof fn !== "function") continue;

  // Declared parameter types straight off the lib.d.ts signature — the whole point
  // is that every generated value conforms to what the signature promises.
  const declared = p.params ?? [];
  if (declared.some((d) => !modelled(d.type))) {
    skipped.push(p.key);
    continue;
  }
  const argPools = declared.map((d) => sample(poolFor(d.type), 4));
  if (argPools.some((pool) => !pool.length)) {
    skipped.push(p.key);
    continue;
  }
  const receivers = isProto ? sample(recvPool, 6) : [holder];

  const observed = [];
  let calls = 0;
  outer: for (const recv of receivers) {
    // arg tuples: vary one position at a time plus the all-first combination
    const tuples = [argPools.map((pool) => pool[0])];
    argPools.forEach((pool, i) =>
      pool.slice(1).forEach((v) => {
        const t = argPools.map((q) => q[0]);
        t[i] = v;
        tuples.push(t);
      }),
    );
    // omitting arguments is only type-conformant when every parameter is optional
    if (declared.every((d) => d.optional)) tuples.push([]);
    for (const args of tuples) {
      if (++calls > MAX_CALLS) break outer;
      try {
        const r = fn.apply(recv, args);
        if (r && typeof r.then === "function") r.then(() => {}, () => {});
      } catch (e) {
        observed.push({
          error: e?.constructor?.name ?? "unknown",
          message: String(e?.message ?? e).slice(0, 90),
          recv: safeShow(recv),
          args: args.map(safeShow),
        });
      }
    }
  }
  results.push({ key: p.key, group: p.group, worst: p.worst, calls, observed });
}

function safeShow(v) {
  try {
    if (typeof v === "symbol") return "Symbol()";
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "function") return "fn";
    if (Array.isArray(v)) return `[${v.length}${Object.isFrozen(v) ? " frozen" : ""}]`;
    if (v && typeof v === "object") return v.constructor?.name ?? "object";
    return String(v);
  } catch {
    return "?";
  }
}

writeFileSync(new URL("./out/fuzz.json", import.meta.url), JSON.stringify(results, null, 2));

/* ---- report ------------------------------------------------------------ */
const ran = results.filter((r) => r.calls > 0);
const threw = ran.filter((r) => r.observed.length);
const g = (n) => ran.filter((r) => r.group === n);
const counterexamples = g(1).filter((r) => r.observed.length);
const confirmed = g(2).filter((r) => r.observed.length);

console.log(`members driven:            ${ran.length} (${ran.reduce((n, r) => n + r.calls, 0)} calls)`);
console.log(`skipped (unmodellable param types): ${skipped.length}`);
console.log(`  observed >=1 throw:      ${threw.length}`);
console.log("");
console.log(`proposed group 1 driven:   ${g(1).length}`);
console.log(`  ↳ COUNTEREXAMPLES:       ${counterexamples.length}`);
console.log(`proposed group 2 driven:   ${g(2).length}`);
console.log(`  ↳ throw reproduced:      ${confirmed.length}  (sensitivity: ${((confirmed.length / Math.max(1, g(2).length)) * 100).toFixed(0)}%)`);
console.log(`REVIEW members driven:     ${ran.filter((r) => r.group === null).length}, of which threw: ${ran.filter((r) => r.group === null && r.observed.length).length}`);
console.log("\ncounterexamples to a proposed group-1 (clean) verdict:");
for (const c of counterexamples.slice(0, 25))
  console.log(`  ${c.key.padEnd(38)} ${c.observed[0].error}: ${c.observed[0].message} [recv ${c.observed[0].recv}, args ${JSON.stringify(c.observed[0].args)}]`);

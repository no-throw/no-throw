import {
  constructTypedArray,
  TYPED_ARRAY_NAMES,
} from "../typed-arrays.js";

/**
 * The hostile pool. Every value here is **type-conformant** — it satisfies the
 * declared type without lying to the checker — and every one of them breaks
 * some builtin. That combination is what makes the gate evidence: a benign
 * fuzzer refutes almost nothing, while these values found every extractor bug
 * across three spikes.
 *
 * `Proxy` is deliberately absent: #14 already puts traps in the trust base, so
 * a Proxy counterexample would refute nothing we claim.
 */

function detachedBuffer(): ArrayBuffer | undefined {
  try {
    const buffer = new ArrayBuffer(8);
    buffer.transfer();
    return buffer;
  } catch {
    return undefined;
  }
}

function detachedView(name: string): unknown[] {
  const out: unknown[] = [];
  const Constructor = (globalThis as Record<string, unknown>)[name];
  if (typeof Constructor !== "function") return out;
  try {
    const buffer = new ArrayBuffer(32);
    const view = Reflect.construct(Constructor, [buffer]);
    buffer.transfer();
    out.push(view);
  } catch {
    /* this engine cannot detach; the member is simply less probed */
  }
  try {
    const buffer = new ArrayBuffer(32, { maxByteLength: 64 });
    const view = Reflect.construct(Constructor, [buffer]);
    buffer.resize(0);
    out.push(view);
  } catch {
    /* likewise for resizable buffers */
  }
  return out;
}

/** Assignable to `Array<T>`, and `ArraySpeciesCreate` throws before it returns. */
function hostileSpeciesArray(): unknown {
  class Hostile extends Array {
    static override get [Symbol.species](): ArrayConstructor {
      return function throwing(): never {
        throw new TypeError("hostile Symbol.species");
      } as unknown as ArrayConstructor;
    }
  }
  return Hostile.from([1, 2, 3]);
}

// An array with a throwing index *accessor* is deliberately not in the pool:
// installing one takes `Object.defineProperty`, which #14 §7 names in the trust
// base alongside `Proxy` and `as`. It refutes nothing we claim, and it does
// manufacture false counterexamples.

export function receiverPool(): ReadonlyMap<string, readonly unknown[]> {
  const pool = new Map<string, readonly unknown[]>([
    [
      "Array",
      [
        [],
        [1, 2, 3],
        ["a", "b"],
        Object.freeze([1, 2, 3]),
        Object.seal([1, 2, 3]),
        [1, , 3],
        hostileSpeciesArray(),
      ],
    ],
    ["String", ["", "abc", "a,b,c", "\u{1F600}", "0"]],
    ["Number", [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]],
    ["Boolean", [true, false]],
    ["BigInt", [1n, -5n]],
    ["Symbol", [Symbol("s")]],
    ["Object", [{}, { a: 1 }, Object.freeze({ a: 1 }), Object.create(null)]],
    ["Function", [function named(a: unknown): unknown { return a; }, () => 1]],
    ["Date", [new Date(0), new Date(Number.NaN)]],
    ["RegExp", [/a/g, /(?<x>b)/u]],
    ["Map", [new Map(), new Map([[1, 2]])]],
    ["Set", [new Set(), new Set([1, 2])]],
    ["WeakMap", [new WeakMap()]],
    ["WeakSet", [new WeakSet()]],
    ["Promise", [Promise.resolve(1)]],
    ["DataView", [new DataView(new ArrayBuffer(8))]],
    ["Error", [new Error("e")]],
  ]);

  const buffers: unknown[] = [new ArrayBuffer(8)];
  const detached = detachedBuffer();
  if (detached !== undefined) buffers.push(detached);
  try {
    buffers.push(new ArrayBuffer(8, { maxByteLength: 16 }));
  } catch {
    /* engines without resizable buffers simply probe less */
  }
  pool.set("ArrayBuffer", buffers);
  if (typeof SharedArrayBuffer === "function") {
    pool.set("SharedArrayBuffer", [new SharedArrayBuffer(8)]);
  }

  for (const name of TYPED_ARRAY_NAMES) {
    const fresh = constructTypedArray(name, 4);
    if (fresh === undefined) continue;
    pool.set(name, [fresh, ...detachedView(name)]);
  }

  return pool;
}

export function describe(value: unknown): string {
  try {
    if (typeof value === "symbol") return "Symbol()";
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function") return "fn";
    if (Array.isArray(value)) {
      return `[${value.length}${Object.isFrozen(value) ? " frozen" : ""}]`;
    }
    if (value !== null && typeof value === "object") {
      return value.constructor?.name ?? "object";
    }
    return String(value);
  } catch {
    return "?";
  }
}

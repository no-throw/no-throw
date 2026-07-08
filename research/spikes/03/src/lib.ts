// A library module — simulates third-party code the consumer imports.

// --- Color carrier option A: a type-brand on the return type ---
declare const NOTHROW: unique symbol;
export type Safe<T> = T & { readonly [NOTHROW]?: true };

// Non-throwing (branded). Returns a discriminated result; brand marks the color.
export function readConfigSafe(key: string): Safe<string | null> {
  return (key.length ? key : null) as Safe<string | null>;
}

// --- Color carrier option B: a JSDoc tag ---
/**
 * Parse an int without throwing.
 * @nothrow
 */
export function parseIntSafe(s: string): number | null {
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

// --- A plainly-throwing function (default color) ---
export function mustParse(s: string): number {
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error("bad number");
  return n;
}

// --- Async: rejects ---
export async function fetchThing(id: string): Promise<string> {
  if (!id) throw new Error("no id");
  return "thing:" + id;
}

// --- Async non-throwing (branded awaited value) ---
export async function fetchThingSafe(id: string): Promise<Safe<string | null>> {
  return (id ? "thing:" + id : null) as Safe<string | null>;
}

// --- Transitive chain for inference: leaf throws, propagates up ---
export function leafThrows(): number { throw new Error("leaf"); }
export function midA(): number { return leafThrows() + 1; }
export function midB(): number { return midA() + 1; }
export function topThrows(): number { return midB() + 1; }

// --- Transitive chain that is genuinely non-throwing ---
export function leafPure(): number { return 42; }
export function midPure(): number { return leafPure() + 1; }
export function topPure(): number { return midPure() + 1; }

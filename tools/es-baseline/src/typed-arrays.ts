/**
 * The twelve typed-array constructors. They share one spec clause family
 * (`%TypedArray%.prototype.*`), one set of receivers in the hostile pool, and
 * one branch of the argument generator, so the list lives in one place — a
 * thirteenth would otherwise have to be remembered in three.
 */
export const TYPED_ARRAY_NAMES = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
] as const;

const NAMES: ReadonlySet<string> = new Set(TYPED_ARRAY_NAMES);

export function isTypedArrayName(name: string): boolean {
  return NAMES.has(name);
}

/** `Int8Array.prototype.map` → `%TypedArray%.prototype.map`. */
export function toTypedArrayIntrinsic(specKey: string): string {
  const head = /^(\w+)/.exec(specKey)?.[1];
  return head !== undefined && NAMES.has(head)
    ? `%TypedArray%${specKey.slice(head.length)}`
    : specKey;
}

/** A new instance, or `undefined` if this engine does not have the type. */
export function constructTypedArray(name: string, length: number): unknown {
  const Constructor = (globalThis as Record<string, unknown>)[name];
  return typeof Constructor === "function"
    ? Reflect.construct(Constructor, [length])
    : undefined;
}

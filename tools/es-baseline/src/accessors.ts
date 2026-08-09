import type { AccessorFact, Color, LibMember, TypeDomains } from "@no-throw/core/baseline";

import { classifyAgainstSpec, specFor } from "./classify.js";
import type { Dials } from "./dials.js";
import type { SpecCorpus } from "./spec/extract.js";

/**
 * `lib.d.ts` declares real getters as plain properties — `Function.arguments`
 * in es5 is the ES case, and the DOM has thousands — so declaration shape is
 * not an oracle. Two independent ones are, and they are combined in the safe
 * direction: *either* saying accessor makes it an accessor.
 *
 * 1. ECMA-262's own `get X` / `set X` clauses.
 * 2. `getOwnPropertyDescriptor` on the live builtin, which is an implementation
 *    of the very algorithms the first oracle is written in.
 *
 * A member neither oracle can see gets **no** fact and therefore floors:
 * absence must keep meaning floor, which is why the safe members carry a
 * positive `accessor: false` record rather than relying on silence.
 */
export function accessorFactFor(
  member: LibMember,
  corpus: SpecCorpus,
  domains: TypeDomains,
  dials: Dials,
): AccessorFact | undefined {
  // Calling or constructing is not a property access, so it has no accessor
  // question to answer.
  if (member.kind === "call" || member.kind === "construct") return undefined;
  const descriptor = runtimeDescriptor(member);
  const getClause = specFor(corpus, `get ${member.specKey}`);
  const setClause = specFor(corpus, `set ${member.specKey}`);

  const specSaysAccessor = getClause !== undefined || setClause !== undefined;
  const runtimeSaysAccessor =
    descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined);

  if (member.declaredAccessor || specSaysAccessor || runtimeSaysAccessor) {
    const colorOf = (clause: typeof getClause): Color =>
      clause === undefined
        ? "throwing"
        : classifyAgainstSpec(clause, member, domains, dials).color;
    return { get: colorOf(getClause), set: colorOf(setClause) };
  }

  if (descriptor === undefined) return undefined;

  // A non-writable data property is not an accessor, but assigning to one
  // throws in strict mode — which is the same consumer-facing question the
  // accessor fact answers, so it is recorded in the same shape rather than
  // being silently read as writable data.
  if (descriptor.writable === false) {
    return { get: "non-throwing", set: "throwing" };
  }
  return false;
}

/** The live descriptor for a member, when this engine has the member at all. */
function runtimeDescriptor(member: LibMember): PropertyDescriptor | undefined {
  const holder = resolveHolder(member.holderPath);
  if (holder === undefined) return undefined;
  const key = runtimeKey(member.name);
  if (key === undefined) return undefined;
  // Up the prototype chain: `Int8Array.prototype.map` is defined on the shared
  // `%TypedArray%.prototype`, and the question is about the property as reached
  // from the holder, not about where it happens to live.
  for (let current: object | null = holder; current !== null; ) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) return descriptor;
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function resolveHolder(holderPath: string): object | undefined {
  let current: unknown = globalThis;
  if (holderPath !== "") {
    for (const step of holderPath.split(".")) {
      if (current === null || current === undefined) return undefined;
      try {
        current = (current as Record<string, unknown>)[step];
      } catch {
        return undefined;
      }
    }
  }
  return typeof current === "object" || typeof current === "function"
    ? (current as object)
    : undefined;
}

export function runtimeKey(name: string): string | symbol | undefined {
  if (!name.startsWith("@@")) return name;
  const wellKnown = (Symbol as unknown as Record<string, unknown>)[name.slice(2)];
  return typeof wellKnown === "symbol" ? wellKnown : undefined;
}

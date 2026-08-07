/**
 * Counterexamples the gate found and the extractor cannot see, recorded so the
 * entry ships **throwing** and the evidence lives in the repo rather than in
 * someone's memory.
 *
 * A counterexample outside this list fails the build — that is what makes the
 * gate a gate. This list is the narrow, auditable exception: each entry names
 * what was observed and why ECMA-262's algorithm steps do not contain it, so
 * "the generator is wrong" stays the default reading of a red gate.
 *
 * Nothing here ever moves an entry toward *clean*. Only toward throwing.
 */
export interface Refutation {
  readonly key: string;
  readonly observed: string;
  readonly why: string;
}

export const REFUTATIONS: readonly Refutation[] = [
  {
    key: "String#padStart",
    observed: `RangeError: Invalid string length — "".padStart(Infinity)`,
    why: "ECMA-262 caps a String at 2**53 - 1 elements but writes no throw step for exceeding it, so extraction cannot see the limit. `maxLength: number` is unbounded, so it is reachable from a conformant argument — and a documented deterministic limit is not the OOM the map rules out of scope.",
  },
  {
    key: "String#padEnd",
    observed: `RangeError: Invalid string length — "".padEnd(Infinity)`,
    why: "Same limit as String#padStart; both go through StringPad.",
  },
];

export const REFUTED_KEYS: ReadonlySet<string> = new Set(
  REFUTATIONS.map((refutation) => refutation.key),
);

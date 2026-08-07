/**
 * The trust-base dials. Each is one question #14 left open — is this hazard
 * reachable by code that does *not* lie to the type system? — decided once as
 * doctrine and then applied by rule to ~50–100 members. They are not a menu:
 * the soundness doctrine fixes their values, and what measuring them bought
 * was knowing the price, not a choice.
 *
 * `hazard` — it throws. Sound, less precise.
 * `trust-base` — held against the type system's model, the same class as
 *   `Proxy` and `as`; the guarantee is relative to that model anyway.
 * `path` — neither: the hazard is expressible as a condition over a parameter
 *   and is discharged at the call site by the argument in hand.
 *
 * Sign-off is one-off. Per release the cost is the symbol diff plus the fuzz
 * gate; see `docs/baseline-dials.md` for the record.
 */
export type DialValue = "hazard" | "trust-base" | "path";

export interface Dials {
  /** A detached or resize-shrunk buffer under a live view. */
  readonly detachedBuffer: DialValue;
  /** `Object.create(null)` as a receiver typed `object`. */
  readonly nullPrototype: DialValue;
  /** `constructor[Symbol.species]`, and `this` as a constructor. */
  readonly subclassHooks: DialValue;
  /** A *method of* a declared object parameter (`Symbol.iterator`, `SetLike.has`). */
  readonly memberCallable: DialValue;
  /** `[[Get]]`/`[[OwnPropertyKeys]]` traps refusing or throwing. */
  readonly proxyTraps: DialValue;
}

export const DIALS: Dials = {
  detachedBuffer: "hazard",
  nullPrototype: "hazard",
  subclassHooks: "hazard",
  // Amended by #23: this one was forced by *inexpressibility*, not soundness,
  // and access paths removed the inexpressibility.
  memberCallable: "path",
  // Already ruled into the trust base by #14: a Proxy is type-identical to its
  // target, so flooring on it would colour nothing.
  proxyTraps: "trust-base",
};

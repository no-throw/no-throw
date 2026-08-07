/**
 * Why a callee resolved to `throwing` with nothing to read. A floor has to say
 * which: "not yet analyzed" and "unknowable from here" are different problems
 * with different fixes, and the diagnostic is the only channel that carries the
 * difference.
 */
export type FloorReason =
  /** Declared with no body, and no carrier colors it. */
  | "bodyless"
  /** A visible body, but no mark — throwing by declaration, under `declare`. */
  | "unmarked"
  /** No declaration at all, so nothing could have colored it. */
  | "unresolvable"
  /**
   * Reached through a function captured from an enclosing scope. A condition
   * is a path over the function's *own* parameters, so a factory's inner
   * function has nothing a call site could discharge.
   */
  | "captured"
  /** A `let` or `var`: a real future refinement, not an unknowable. */
  | "mutable-binding"
  /**
   * Non-throwing only given conditions of its own. A hidden transfer reaches
   * its target through a type rather than being handed one, so no argument is
   * written at the site that could discharge them.
   */
  | "conditioned";

/**
 * Why a callee is throwing. `inferred` is the one answer that is not a floor:
 * the body was read and it can throw, so the outs a floor names — assert it,
 * overlay it, ship a manifest — would be silencing a true positive.
 */
export type ThrowingReason = FloorReason | "inferred";

/**
 * Why an argument failed to discharge the condition it was passed for. The
 * floor reasons carry over unchanged — the argument is a callee once the call
 * runs — and the rest are shapes only an argument has.
 */
export type UndischargedReason =
  | FloorReason
  /** The conditioned parameter got no argument, so there is none to read. */
  | "missing-argument"
  /** Propagating it would produce a path deeper than the engine follows. */
  | "beyond-depth";

/**
 * Why a promise can reject. Reject-ness rides our color and nothing else — a
 * rejecting and a non-rejecting `async` function have the identical type — so
 * everything a callee can be carries over, plus the shapes only a promise in
 * hand has.
 */
export type RejectionReason =
  | ThrowingReason
  /**
   * Nothing in the syntax names the call that produced it: a parameter, a
   * property, a non-call initializer, a stored partial chain.
   */
  | "untraced"
  /**
   * The producing call's callee is a parameter. A condition says calling it is
   * clean and has no form for "and the promise it hands back never rejects".
   */
  | "conditioned-producer"
  /**
   * A handler in the chain is reached through a parameter. Conditioning a chain
   * handler is a mechanism the engine does not have.
   */
  | "conditioned-handler";

/**
 * Why consuming an iterator is throwing. Everything a callee can be carries
 * over — the protocol resolves to bodies like anything else, and a `let` is the
 * same deferred refinement here — plus the one shape only a produced value has:
 * the expression→originating-call rule naming no call at all.
 */
export type ConsumptionReason =
  | ThrowingReason
  /** Nothing in the syntax names the call that produced it. */
  | "untraced"
  /**
   * The producing call's callee is a parameter. A condition says calling it is
   * clean and has no form for "and consuming what it hands back is too", so
   * there is nothing a caller could discharge.
   */
  | "conditioned-producer";

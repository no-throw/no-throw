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
  | "mutable-binding";

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
  /** Non-throwing only given conditions of its own, which nothing here can discharge. */
  | "conditioned"
  /** The conditioned parameter got no argument, so there is none to read. */
  | "missing-argument"
  /** Propagating it would produce a path deeper than the engine follows. */
  | "beyond-depth";

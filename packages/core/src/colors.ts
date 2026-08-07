/**
 * Why a callee resolved to `throwing`. A floor has to say which: "not yet
 * analyzed" and "unknowable from here" are different problems with different
 * fixes, and the diagnostic is the only channel that carries the difference.
 */
export type FloorReason =
  /** Declared with no body, and no carrier colors it. */
  | "bodyless"
  /** A visible body, but no mark — throwing by declaration. */
  | "unmarked"
  /** No declaration at all, so nothing could have colored it. */
  | "unresolvable";

/** A callee's color at a call site, plus — when it floored — why. */
export type CalleeColor =
  | { readonly color: "non-throwing" }
  | { readonly color: "throwing"; readonly reason: FloorReason };

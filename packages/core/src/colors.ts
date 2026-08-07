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
  | "unresolvable";

/**
 * Why a callee is throwing. `inferred` is the one answer that is not a floor:
 * the body was read and it can throw, so the outs a floor names — assert it,
 * overlay it, ship a manifest — would be silencing a true positive.
 */
export type ThrowingReason = FloorReason | "inferred";

/** A color, plus — when it is throwing — why, in whatever vocabulary fits. */
export type Colored<Reason extends string> =
  | { readonly color: "non-throwing" }
  | { readonly color: "throwing"; readonly reason: Reason };

/** A callee's color at a call site. */
export type CalleeColor = Colored<ThrowingReason>;

/**
 * Why consuming an iterator is throwing. The floors a callee can hit are all
 * reachable here too — the protocol resolves to bodies like anything else — and
 * two more are the iterator's own, both from the expression→originating-call
 * rule failing to name the call that produced the value. They are kept apart
 * because their fixes are: one is a refinement we owe you, the other is a
 * question the syntax cannot answer.
 */
export type ConsumptionReason =
  | ThrowingReason
  /** A binding the rule does not follow yet — a `let`, a computed initializer. */
  | "untraced-binding"
  /** Nothing in the syntax names the producing call at all. */
  | "untraced-opaque";

/** The color of consuming an iterator. */
export type ConsumptionColor = Colored<ConsumptionReason>;

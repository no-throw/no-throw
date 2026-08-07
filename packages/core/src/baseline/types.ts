/**
 * The shipped standard-library baseline: engine data in `@nothrow/core`, keyed
 * by lib target. It is not an overlay — overlay discovery matches a manifest's
 * `package` field against an npm package, and `lib.es5.d.ts` has none.
 *
 * Entry fields mirror the manifest's, deliberately: the same four facts, with
 * the same fail-safe reading of absence, so the resolver chain composes the
 * baseline the same way it composes every other rung.
 */

export type Color = "throwing" | "non-throwing";

/**
 * An access path over a member's own parameters. Root `param<N>`, then any of
 * `.member`, `[]` for element access, `.@@name` for a well-known symbol —
 * `"param0.save"`, `"param0[].run"`, `"param0.@@iterator"`. The grammar is
 * closed; anything else floors the entry.
 */
export type ConditionPath = string;

export interface AccessorColors {
  readonly get: Color;
  readonly set: Color;
}

/**
 * `false` is a *positive* record that a declared property really is data. The
 * distinction is load-bearing: absence floors, so silence can never be read as
 * "it is only a property".
 */
export type AccessorFact = false | AccessorColors;

export interface BaselineEntry {
  /** Absent on pure accessor facts — reading a data property is not a call. */
  readonly color?: Color;
  /** Default `false`: absence must mean "might sync-throw". */
  readonly async?: boolean;
  /**
   * Absence means *maximally conditioned* — every callable parameter is
   * conditioned at whole-value granularity. Unconditional cleanliness is
   * recorded positively as `[]`, so forgetting is over-strict, never a lie.
   */
  readonly conditions?: readonly ConditionPath[];
  readonly accessor?: AccessorFact;
  /**
   * Where this entry was adjudicated from — an ECMA-262 clause name, or a
   * `spec#anchor` into the prose that defines a DOM member. Audit trail.
   */
  readonly spec?: string;
  /** Dotted runtime path (`Array.prototype.push`), for the fuzz gate. */
  readonly runtime?: string;
}

export interface BaselineLib {
  readonly [memberKey: string]: BaselineEntry;
}

export interface BaselineData {
  readonly version: 1;
  /**
   * Members the generator proposed clean but the fuzz gate could not reach for
   * want of a constructible receiver or a modelable argument. They ship
   * floored — unprobed is not refuted, and it is never evidence either.
   */
  readonly unprobed: readonly string[];
  readonly libs: { readonly [libTarget: string]: BaselineLib };
}

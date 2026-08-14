import ts from "typescript";

/**
 * Types whose every value is a primitive standing on a prototype the program
 * did not write. Two questions turn on that and are asked with this mask:
 * coercing one runs no user code, and a member of one is whatever the
 * prototype holds — no subtype can put anything else there, because a
 * primitive type has no subtype to override with.
 *
 * The prototype itself is the trust base the dials already ruled on, in both
 * readings.
 */
export const PRIMITIVE_VALUE =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike;

/**
 * The types with no value behind them to run anything: nothing is coerced, and
 * a member read off one is a `TypeError` rather than a body. Only the first
 * question takes them, since "nothing runs" is an answer to it and reaching a
 * member of `null` is not.
 */
export const NO_VALUE =
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void |
  ts.TypeFlags.Never;

/**
 * Whether every value a type admits is one of `flags`. A union has to answer
 * for all of its constituents, and a type parameter answers through its
 * constraint — not itself a primitive, but one that is bounds every value it
 * can hold, so `${k}` on `K extends string` costs nothing and `k.trim` is
 * `String.prototype`'s.
 */
export function everyValueIs(
  type: ts.Type,
  flags: ts.TypeFlags,
  checker: ts.TypeChecker,
): boolean {
  const constituents = type.isUnion() ? type.types : [type];
  if (constituents.every((part) => (part.flags & flags) !== 0)) return true;

  const constraint = checker.getBaseConstraintOfType(type);
  return constraint === undefined || constraint === type
    ? false
    : everyValueIs(constraint, flags, checker);
}

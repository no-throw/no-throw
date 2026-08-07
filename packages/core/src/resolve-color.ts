import ts from "typescript";
import type { CalleeColor } from "./colors.js";
import { bodyOf, isMarked } from "./declarations.js";

/**
 * The color-resolution seam. Every "what color is this callee?" question goes
 * through here, so inference and the resolver chain — overrides, overlays,
 * shipped manifests, the baseline — land behind this one function instead of
 * being threaded through the walk.
 *
 * Only two color sources exist so far: a mark says non-throwing, and everything
 * else floors. That is exactly the pure-declare floor the design degrades to,
 * and it is the sound end of the range, not a placeholder.
 */
export function resolveCalleeColor(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): CalleeColor {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || !ts.isFunctionLike(declaration)) {
    return { color: "throwing", reason: "unresolvable" };
  }
  if (isMarked(declaration)) return { color: "non-throwing" };

  return {
    color: "throwing",
    reason: bodyOf(declaration) === undefined ? "bodyless" : "unmarked",
  };
}

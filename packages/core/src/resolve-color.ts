import ts from "typescript";
import type { CalleeColor } from "./colors.js";
import { bodyOf } from "./declarations.js";
import { unbridgedEscapes } from "./escapes.js";
import { createFixpoint, type BodyEdges } from "./infer.js";
import { isMarkedFunction } from "./marks.js";
import { colorPolicy } from "./policy.js";

/**
 * The color-resolution seam. Every "what color is this callee?" question goes
 * through here, so inference and the resolver chain — overrides, overlays,
 * shipped manifests, the baseline — land behind this one object instead of
 * being threaded through the walk.
 *
 * Inference is the last rung and a removable one: with the `declare` policy the
 * chain stops at the pins and everything unmarked floors, which is the sound
 * end of the range rather than a degraded mode.
 */
export interface ColorResolver {
  at(call: ts.CallExpression): CalleeColor;
}

export function createColorResolver(checker: ts.TypeChecker): ColorResolver {
  const policy = colorPolicy();
  const fixpoint = createFixpoint((fn) => edgesOf(fn, checker));

  return {
    at(call) {
      const callee = classify(call, checker);
      if (callee.kind === "pinned") return callee.color;
      if (policy === "declare") {
        return { color: "throwing", reason: "unmarked" };
      }
      return fixpoint.isThrowing(callee.declaration)
        ? { color: "throwing", reason: "inferred" }
        : { color: "non-throwing" };
    },
  };
}

type CalleeResolution =
  /** Colored without reading a body, and so cutting the graph. */
  | { readonly kind: "pinned"; readonly color: CalleeColor }
  | {
      readonly kind: "inferable";
      readonly declaration: ts.SignatureDeclaration;
    };

/**
 * The chain up to, but not including, inference. A mark is trusted here and
 * verified separately against its own body — assume-then-verify, so a cycle
 * through a seed is colored against the mark and a lying mark fails loud where
 * it was written rather than quietly poisoning its callers.
 */
function classify(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): CalleeResolution {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined || !ts.isFunctionLike(declaration)) {
    return pin({ color: "throwing", reason: "unresolvable" });
  }
  if (isMarkedFunction(declaration)) return pin({ color: "non-throwing" });
  if (bodyOf(declaration) === undefined) {
    return pin({ color: "throwing", reason: "bodyless" });
  }
  return { kind: "inferable", declaration };
}

function pin(color: CalleeColor): CalleeResolution {
  return { kind: "pinned", color };
}

/** One body's contribution to the graph, off the walk enforcement also uses. */
function edgesOf(
  fn: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): BodyEdges {
  let throws = false;
  const callees: ts.SignatureDeclaration[] = [];

  for (const escape of unbridgedEscapes(fn)) {
    if (ts.isThrowStatement(escape)) {
      throws = true;
      continue;
    }
    const callee = classify(escape, checker);
    if (callee.kind === "inferable") callees.push(callee.declaration);
    else if (callee.color.color === "throwing") throws = true;
  }

  return { throws, callees };
}

import ts from "typescript";
import type { CalleeColor } from "./colors.js";
import {
  baseClassExpression,
  bodyOf,
  constructedBody,
  hasVisibleBody,
  inheritedFrom,
  type Bodied,
} from "./declarations.js";
import { calleeExpression, unbridgedEscapes, type Transfer } from "./escapes.js";
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
  at(transfer: Transfer): CalleeColor;
}

export function createColorResolver(checker: ts.TypeChecker): ColorResolver {
  const policy = colorPolicy();
  const fixpoint = createFixpoint((body) => edgesOf(body, checker));

  return {
    at(transfer) {
      const callee = classify(targetOf(transfer, checker));
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
  | { readonly kind: "inferable"; readonly declaration: Bodied };

/**
 * The chain up to, but not including, inference. A mark is trusted here and
 * verified separately against its own body — assume-then-verify, so a cycle
 * through a seed is colored against the mark and a lying mark fails loud where
 * it was written rather than quietly poisoning its callers.
 */
function classify(target: Bodied | undefined): CalleeResolution {
  if (target === undefined) {
    return pin({ color: "throwing", reason: "unresolvable" });
  }
  if (isMarkedFunction(target)) return pin({ color: "non-throwing" });
  if (!hasVisibleBody(target)) {
    return pin({ color: "throwing", reason: "bodyless" });
  }
  return { kind: "inferable", declaration: target };
}

function pin(color: CalleeColor): CalleeResolution {
  return { kind: "pinned", color };
}

/** The body an escape site transfers control into, where one can be named. */
function targetOf(
  transfer: Transfer,
  checker: ts.TypeChecker,
): Bodied | undefined {
  if (ts.isNewExpression(transfer)) {
    return (
      constructedBodyAt(transfer.expression, checker) ??
      constructSignatureOf(transfer, checker)
    );
  }
  if (calleeExpression(transfer).kind === ts.SyntaxKind.SuperKeyword) {
    const base = inheritedFrom(transfer);
    return base === undefined ? undefined : constructedBodyAt(base, checker);
  }

  const declaration = checker.getResolvedSignature(transfer)?.declaration;
  return declaration !== undefined && ts.isFunctionLike(declaration)
    ? declaration
    : undefined;
}

/**
 * The class a constructor-position expression denotes, and the body `new` on it
 * enters. The resolved *signature* is no substitute: a derived class that
 * declares no constructor resolves to its base's, which would skip the derived
 * class's own field initializers.
 */
function constructedBodyAt(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): Bodied | undefined {
  const declaration =
    checker.getTypeAtLocation(expression).symbol?.valueDeclaration;
  return declaration !== undefined && ts.isClassLike(declaration)
    ? constructedBody(declaration)
    : undefined;
}

/**
 * A construct signature with no class behind it — `new Error()`, an interface's
 * `new ()` — is a bodyless declaration, and saying that beats saying nothing
 * resolved. Only a bodyless one is taken: a bodied signature the class lookup
 * missed means the expression was not one class, and reading a single branch of
 * it would be a guess.
 */
function constructSignatureOf(
  construction: ts.NewExpression,
  checker: ts.TypeChecker,
): ts.SignatureDeclaration | undefined {
  const declaration = checker.getResolvedSignature(construction)?.declaration;
  return declaration !== undefined &&
    ts.isFunctionLike(declaration) &&
    bodyOf(declaration) === undefined
    ? declaration
    : undefined;
}

/** One body's contribution to the graph, off the walk enforcement also uses. */
function edgesOf(declaration: Bodied, checker: ts.TypeChecker): BodyEdges {
  let throws = false;
  const callees: Bodied[] = [];

  const follow = (callee: CalleeResolution): void => {
    if (callee.kind === "inferable") callees.push(callee.declaration);
    else if (callee.color.color === "throwing") throws = true;
  };

  for (const escape of unbridgedEscapes(declaration)) {
    if (ts.isThrowStatement(escape)) {
      throws = true;
      continue;
    }
    follow(classify(targetOf(escape, checker)));
  }

  // A class stands for a constructor it does not declare, and the implicit
  // `constructor(...args) { super(...args) }` still runs the base's effective
  // body. There is no `super()` in the syntax for the walk to have found.
  if (ts.isClassLike(declaration)) {
    const base = baseClassExpression(declaration);
    if (base !== undefined) follow(classify(constructedBodyAt(base, checker)));
  }

  return { throws, callees };
}

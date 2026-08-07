import ts from "typescript";
import type { FloorReason } from "./colors.js";
import {
  parameterRoot,
  pathOf,
  skipParens,
  type ParameterPath,
} from "./conditions.js";
import {
  bodyOf,
  constructedBody,
  hasVisibleBody,
  inheritedFrom,
  isAmbient,
  type Bodied,
} from "./declarations.js";
import { calleeExpression, type Transfer } from "./escapes.js";
import { isMarkedFunction } from "./marks.js";

/**
 * What an expression in callee or argument position turns out to name. The two
 * positions ask the same question — whose body would run — so they get the
 * same answer type and the same resolver.
 */
export type Target =
  /** A path over the asking function's own parameters: a condition, not a floor. */
  | { readonly kind: "condition"; readonly path: ParameterPath }
  | {
      readonly kind: "function";
      readonly declaration: Bodied;
      /** Marked, so its color is pinned and its body is enforced elsewhere. */
      readonly marked: boolean;
    }
  | { readonly kind: "floor"; readonly reason: FloorReason };

/**
 * What an expression resolved to, or why it did not. `mutable` is kept apart
 * from `unknown` because a `let` is a refinement the engine has not made yet,
 * while an unfollowable expression is unknowable from here.
 */
export type ValueResolution =
  | { readonly kind: "targets"; readonly targets: readonly Target[] }
  | { readonly kind: "mutable" }
  | { readonly kind: "unknown" };

/** The same answer for an expression a path is walked through, not entered. */
export type ReceiverResolution =
  | { readonly kind: "values"; readonly values: readonly ts.Expression[] }
  | { readonly kind: "mutable" }
  | { readonly kind: "unknown" };

/**
 * The callee of one transfer, as seen from the body it is written in. A join,
 * not a single answer: losing the callee to a branch means every function the
 * branch can reach, which over-approximates the condition set rather than
 * guessing which arm runs.
 */
export function calleeTargets(
  transfer: Transfer,
  body: Bodied,
  checker: ts.TypeChecker,
): readonly Target[] {
  const resolved = resolveValue(calleeExpression(transfer), body, checker);
  if (resolved.kind === "targets") return resolved.targets;
  // The signature is the function *type*, which is what a reassignable binding
  // resolves to and is one of the values it can hold, not the one that runs.
  if (resolved.kind === "mutable") return [floor("mutable-binding")];
  return [transferTarget(transfer, checker)];
}

/**
 * Follow an expression to the functions it can name. Only single-assignment
 * shapes are followed — a function literal, a `const` bound to one, a branch
 * between them — because those are the ones where the answer cannot change
 * between here and the call.
 */
export function resolveValue(
  expr: ts.Expression,
  body: Bodied,
  checker: ts.TypeChecker,
  seen: Set<ts.Node> = new Set(),
): ValueResolution {
  const expression = skipParens(expr);

  const root = parameterRoot(expression, body, checker);
  if (root === "own") {
    const path = pathOf(expression, body, checker);
    return path === undefined
      ? { kind: "unknown" }
      : { kind: "targets", targets: [{ kind: "condition", path }] };
  }
  if (root === "captured") {
    return { kind: "targets", targets: [floor("captured")] };
  }

  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
    return { kind: "targets", targets: [functionTarget(expression)] };
  }

  if (ts.isConditionalExpression(expression)) {
    const whenTrue = resolveValue(expression.whenTrue, body, checker, seen);
    if (whenTrue.kind !== "targets") return whenTrue;
    const whenFalse = resolveValue(expression.whenFalse, body, checker, seen);
    if (whenFalse.kind !== "targets") return whenFalse;
    return {
      kind: "targets",
      targets: [...whenTrue.targets, ...whenFalse.targets],
    };
  }

  if (ts.isIdentifier(expression)) {
    return resolveBinding(expression, body, checker, seen);
  }

  return { kind: "unknown" };
}

function resolveBinding(
  identifier: ts.Identifier,
  body: Bodied,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
): ValueResolution {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (declaration === undefined) return { kind: "unknown" };

  if (ts.isFunctionDeclaration(declaration)) {
    return { kind: "targets", targets: [declarationTarget(declaration)] };
  }

  if (!ts.isVariableDeclaration(declaration)) return { kind: "unknown" };
  // An ambient `declare var` — `Error` among them — is a bodyless declaration
  // wearing a mutable binding's syntax, not a value the engine could one day
  // track through its assignments. The declaration is what answers for it.
  if (isAmbient(declaration)) return { kind: "unknown" };
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) {
    return { kind: "mutable" };
  }

  const { initializer } = declaration;
  if (initializer === undefined || seen.has(declaration)) {
    return { kind: "unknown" };
  }
  seen.add(declaration);
  return resolveValue(initializer, body, checker, seen);
}

/**
 * Follow an expression to the values it can hold, for a path that has to be
 * walked *through* it rather than entered. A binding's declared type is only a
 * supertype's promise — a subclass can override the very member the path names
 * — so the walk starts at the value in hand, whose own type is exact.
 */
export function resolveReceiver(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node> = new Set(),
): ReceiverResolution {
  const expression = skipParens(expr);

  if (
    ts.isObjectLiteralExpression(expression) ||
    ts.isNewExpression(expression)
  ) {
    return { kind: "values", values: [expression] };
  }

  if (ts.isConditionalExpression(expression)) {
    const whenTrue = resolveReceiver(expression.whenTrue, checker, seen);
    if (whenTrue.kind !== "values") return whenTrue;
    const whenFalse = resolveReceiver(expression.whenFalse, checker, seen);
    if (whenFalse.kind !== "values") return whenFalse;
    return { kind: "values", values: [...whenTrue.values, ...whenFalse.values] };
  }

  if (!ts.isIdentifier(expression)) return { kind: "unknown" };

  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) {
    return { kind: "unknown" };
  }
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) {
    return { kind: "mutable" };
  }

  const { initializer } = declaration;
  if (initializer === undefined || seen.has(declaration)) {
    return { kind: "unknown" };
  }
  seen.add(declaration);
  return resolveReceiver(initializer, checker, seen);
}

/**
 * The target a member of a value names, joined over its declarations. Which
 * function a member holds is answered by the checker's symbol for it, which is
 * the whole reason a condition can reach past depth 0 at all.
 */
export function memberTargets(
  value: ts.Expression,
  members: readonly string[],
  checker: ts.TypeChecker,
): readonly Target[] {
  let type = checker.getTypeAtLocation(value);
  let symbol: ts.Symbol | undefined;

  for (const member of members) {
    symbol = type.getProperty(member);
    if (symbol === undefined) return [floor("unresolvable")];
    type = checker.getTypeOfSymbolAtLocation(symbol, value);
  }

  const declarations = symbol?.declarations ?? [];
  if (declarations.length === 0) return [floor("unresolvable")];
  return declarations.map(memberTarget);
}

function memberTarget(declaration: ts.Declaration): Target {
  if (
    ts.isMethodDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration)
  ) {
    return declarationTarget(declaration);
  }

  const initializer = initializerOf(declaration);
  if (
    initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  ) {
    return functionTarget(initializer);
  }

  return floor(
    ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration)
      ? "bodyless"
      : "unresolvable",
  );
}

function initializerOf(declaration: ts.Declaration): ts.Expression | undefined {
  if (
    ts.isPropertyAssignment(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isVariableDeclaration(declaration)
  ) {
    return declaration.initializer;
  }
  return undefined;
}

/**
 * The chain up to, but not including, inference: a mark is trusted here and
 * verified separately against its own body — assume-then-verify, so a cycle
 * through a seed is colored against the mark and a lying mark fails loud where
 * it was written rather than quietly poisoning its callers.
 */
function transferTarget(transfer: Transfer, checker: ts.TypeChecker): Target {
  const target = targetOf(transfer, checker);
  if (target === undefined) return floor("unresolvable");
  return hasVisibleBody(target) ? functionTarget(target) : floor("bodyless");
}

/**
 * The body `new` on a constructor-position expression enters, as a target. The
 * implicit `constructor(...args) { super(...args) }` a class does not declare
 * has no syntax for the walk to find, so its edge is asked for by name.
 */
export function constructedTarget(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): Target {
  const body = constructedBodyAt(expression, checker);
  return body === undefined ? floor("unresolvable") : declarationTarget(body);
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

/**
 * A declaration named by something other than a transfer — a protocol member
 * reached through the static type — as a target.
 */
export function declarationTarget(declaration: Bodied): Target {
  return hasVisibleBody(declaration)
    ? functionTarget(declaration)
    : floor("bodyless");
}

function functionTarget(declaration: Bodied): Target {
  return {
    kind: "function",
    declaration,
    marked: isMarkedFunction(declaration),
  };
}

function floor(reason: FloorReason): Target {
  return { kind: "floor", reason };
}

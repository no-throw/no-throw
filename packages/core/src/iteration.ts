import ts from "typescript";
import { bodyOf, type Bodied } from "./declarations.js";

/**
 * Which part of the iteration protocol a site runs, and so which members
 * answer for it.
 */
export type Protocol =
  /** `[Symbol.iterator]()`, then the iterator it hands back, driven to done. */
  | { readonly kind: "iterable" }
  /** An iterator's whole surface, because a consumer may use any of it. */
  | { readonly kind: "iterator" }
  /** One member, because the syntax says which one runs. */
  | { readonly kind: "member"; readonly name: "next" | "return" }
  /** `.throw()`, which never takes a color: it is the consumer throwing. */
  | { readonly kind: "throw" };

/** A site where a lazily-produced body actually runs. */
export interface Consumption {
  /** Where the diagnostic lands. */
  readonly node: ts.Node;
  readonly protocol: Protocol;
  /**
   * The expression denoting the iterable, where the syntax names one — the
   * input to the expression→originating-call rule. A destructuring pattern
   * fed by a loop variable names nothing, and answers by type alone.
   */
  readonly source: ts.Expression | undefined;
  /** The node whose type describes what is being consumed. */
  readonly typeAt: ts.Node;
}

const ITERABLE: Protocol = { kind: "iterable" };

/**
 * The consumption site at this node, if it is one. Every form here runs
 * `[Symbol.iterator]()` and then `next()` — that is what makes them one kind of
 * escape rather than five — except the iterator methods, which the syntax hands
 * the iterator directly.
 */
export function iterationSiteAt(
  node: ts.Node,
  checker: ts.TypeChecker,
): Consumption | undefined {
  if (ts.isForOfStatement(node)) {
    return {
      node: node.expression,
      protocol: ITERABLE,
      source: node.expression,
      typeAt: node.expression,
    };
  }

  // `...x` in an array literal or an argument list iterates; the same token in
  // an assignment target is a rest binding, and `{ ...o }` is a different node
  // kind entirely — object spread copies properties and iterates nothing.
  if (ts.isSpreadElement(node) && !isAssignmentTarget(node)) {
    return { node, protocol: ITERABLE, source: node.expression, typeAt: node.expression };
  }

  if (
    ts.isYieldExpression(node) &&
    node.asteriskToken !== undefined &&
    node.expression !== undefined
  ) {
    return { node, protocol: ITERABLE, source: node.expression, typeAt: node.expression };
  }

  if (ts.isArrayBindingPattern(node)) {
    const source = destructuredSource(node);
    return { node, protocol: ITERABLE, source, typeAt: source ?? node };
  }

  if (ts.isArrayLiteralExpression(node)) {
    const assigned = destructuringAssignment(node);
    if (assigned !== undefined) {
      const { source } = assigned;
      return { node, protocol: ITERABLE, source, typeAt: source ?? node };
    }
  }

  return iteratorMethodCall(node, checker);
}

/**
 * `it.next()`, `it.return()` and `it.throw()`, but only where the member is the
 * protocol's rather than one somebody wrote. A hand-written iterator's own
 * `next` has a body to read, and reading it is more precise than asking which
 * call produced the receiver — so it stays an ordinary call.
 */
function iteratorMethodCall(
  node: ts.Node,
  checker: ts.TypeChecker,
): Consumption | undefined {
  if (!ts.isCallExpression(node)) return undefined;

  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  const name = callee.name.text;
  if (name !== "next" && name !== "return" && name !== "throw") return undefined;

  const receiver = callee.expression;
  if (!isIteratorType(checker.getTypeAtLocation(receiver), checker)) {
    return undefined;
  }

  const declaration = checker.getResolvedSignature(node)?.declaration;
  if (
    declaration !== undefined &&
    ts.isFunctionLike(declaration) &&
    bodyOf(declaration) !== undefined
  ) {
    return undefined;
  }

  return {
    node,
    protocol: name === "throw" ? { kind: "throw" } : { kind: "member", name },
    source: receiver,
    typeAt: receiver,
  };
}

/**
 * Whether the type is an iterator: it has a `next` that answers with something
 * shaped like an `IteratorResult`. The result shape is what keeps an ordinary
 * object with a `next` method — a linked-list node, a parser cursor — from
 * being read as one.
 */
export function isIteratorType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const next = checker.getPropertyOfType(checker.getApparentType(type), "next");
  if (next === undefined) return false;

  return checker
    .getTypeOfSymbol(next)
    .getCallSignatures()
    .some(
      (signature) =>
        checker.getPropertyOfType(signature.getReturnType(), "done") !==
        undefined,
    );
}

/**
 * The declaration behind a protocol member, bodied or not — a bodyless one is
 * an answer ("the standard library's, and nothing colors it") rather than a
 * missing one.
 */
export function protocolMember(
  type: ts.Type,
  name: "next" | "return" | "iterator",
  checker: ts.TypeChecker,
): Bodied | undefined {
  const apparent = checker.getApparentType(type);
  const symbol =
    name === "iterator"
      ? wellKnownIterator(apparent, checker)
      : checker.getPropertyOfType(apparent, name);

  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration !== undefined && ts.isFunctionLike(declaration)
    ? declaration
    : undefined;
}

/**
 * `[Symbol.iterator]`, found by scanning: TypeScript names well-known symbol
 * members `__@iterator@<id>` with an id that is not ours to predict, so the
 * name cannot be handed to `getPropertyOfType`.
 */
function wellKnownIterator(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  return checker
    .getPropertiesOfType(type)
    .find((property) => String(property.escapedName).startsWith("__@iterator@"));
}

/** The expression a destructuring pattern is fed by, where there is one. */
function destructuredSource(
  pattern: ts.ArrayBindingPattern,
): ts.Expression | undefined {
  const { parent } = pattern;
  // A parameter's initializer is its *default* — it runs only when the
  // argument is missing, so it does not name what the pattern destructures.
  return ts.isVariableDeclaration(parent) && parent.name === pattern
    ? parent.initializer
    : undefined;
}

/**
 * What an array literal in assignment-target position destructures, or nothing
 * where the literal is an ordinary one. A `for…of` target *is* one and still
 * names no expression: what it destructures is the loop's element.
 */
function destructuringAssignment(
  target: ts.ArrayLiteralExpression,
): { readonly source: ts.Expression | undefined } | undefined {
  const { parent } = target;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === target
  ) {
    return { source: parent.right };
  }
  return ts.isForOfStatement(parent) && parent.initializer === target
    ? { source: undefined }
    : undefined;
}

/** Whether a node sits inside an assignment's target rather than a value. */
function isAssignmentTarget(node: ts.Node): boolean {
  for (let child: ts.Node = node; ; child = child.parent) {
    const { parent } = child;
    if (parent === undefined) return false;
    if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)) {
      continue;
    }
    return (
      (ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === child) ||
      (ts.isForOfStatement(parent) && parent.initializer === child)
    );
  }
}

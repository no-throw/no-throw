import ts from "typescript";
import { bodyOf, hasModifier, type Bodied } from "./declarations.js";

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
  | { readonly kind: "member"; readonly name: "next" | "return" };

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
  /**
   * Whether the site runs `[Symbol.asyncIterator]`. Only `for await` does, and
   * it falls back to the synchronous member where the value has no async one —
   * so this picks which member answers rather than which protocol exists.
   */
  readonly async: boolean;
}

/**
 * What the protocol makes of a node. `.throw()` is not a consumption site with
 * an unlucky color: nothing colors it at all, because the value it throws is
 * written right there — so it is a kind of its own rather than a case every
 * consumer of a `Consumption` has to remember to check.
 */
export type IterationEscape =
  | { readonly kind: "consumption"; readonly site: Consumption }
  | { readonly kind: "iterator-throw"; readonly node: ts.Node };

/** A member the protocol runs; `iterator` is `[Symbol.iterator]`. */
export type ProtocolMemberName = "next" | "return" | "iterator";

/**
 * The escape the iteration protocol makes of this node, if it makes one. Every
 * consumption form here runs `[Symbol.iterator]()` and then `next()` — that is
 * what makes them one kind of escape rather than five — except the iterator
 * methods, which the syntax hands the iterator directly.
 */
export function iterationEscapeAt(
  node: ts.Node,
  checker: ts.TypeChecker,
): IterationEscape | undefined {
  if (ts.isForOfStatement(node)) {
    return iterating(
      node.expression,
      node.expression,
      node.awaitModifier !== undefined,
    );
  }

  // `...x` in an array literal or an argument list iterates; the same token in
  // an assignment target is a rest binding, and `{ ...o }` is a different node
  // kind entirely — object spread copies properties and iterates nothing.
  if (ts.isSpreadElement(node)) {
    return isAssignmentTarget(node)
      ? undefined
      : iterating(node, node.expression, false);
  }

  if (ts.isYieldExpression(node) && node.asteriskToken !== undefined) {
    return node.expression === undefined
      ? undefined
      : iterating(node, node.expression, isInAsyncGenerator(node));
  }

  if (ts.isArrayBindingPattern(node)) {
    return iterating(node, destructuredSource(node), false);
  }

  if (ts.isArrayLiteralExpression(node)) {
    const assigned = assignedTo(node);
    return assigned === undefined
      ? undefined
      : iterating(node, assigned.from, false);
  }

  return iteratorMethodCall(node, checker);
}

/** A site that starts from an iterable, reported at `node`. */
function iterating(
  node: ts.Node,
  source: ts.Expression | undefined,
  async: boolean,
): IterationEscape {
  return {
    kind: "consumption",
    site: {
      node,
      protocol: { kind: "iterable" },
      source,
      typeAt: source ?? node,
      async,
    },
  };
}

/** Whether a `yield*` delegates over the asynchronous protocol. */
function isInAsyncGenerator(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      return hasModifier(n, ts.SyntaxKind.AsyncKeyword);
    }
  }
  return false;
}

/**
 * `it.next()`, `it.return()` and `it.throw()`, but only where the receiver is
 * an iterator.
 *
 * `next` and `return` are colored by what they run, so a hand-written
 * iterator's own — which has a body to read — stays an ordinary call, and
 * reading it beats asking which call produced the receiver. `.throw()` is not
 * colored by anything: whatever the member does, the consumer wrote a throw,
 * and a throw cannot be laundered through an iterator.
 */
function iteratorMethodCall(
  node: ts.Node,
  checker: ts.TypeChecker,
): IterationEscape | undefined {
  if (!ts.isCallExpression(node)) return undefined;

  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  const name = callee.name.text;
  if (name !== "next" && name !== "return" && name !== "throw") return undefined;

  const receiver = callee.expression;
  if (!isIteratorType(checker.getTypeAtLocation(receiver), checker)) {
    return undefined;
  }

  if (name === "throw") return { kind: "iterator-throw", node };
  if (hasVisibleBody(checker.getResolvedSignature(node)?.declaration)) {
    return undefined;
  }

  return {
    kind: "consumption",
    site: {
      node,
      protocol: { kind: "member", name },
      source: receiver,
      typeAt: receiver,
      // The syntax names the member, so there is no `[Symbol.iterator]` to
      // choose a spelling of.
      async: false,
    },
  };
}

function hasVisibleBody(declaration: ts.Declaration | undefined): boolean {
  return (
    declaration !== undefined &&
    ts.isFunctionLike(declaration) &&
    bodyOf(declaration) !== undefined
  );
}

/**
 * The types a value can actually have at a site. A union has to be joined
 * rather than sampled: `Clean | Broken` runs whichever protocol the value turns
 * out to carry, and coloring one constituent would color by coin toss.
 */
export function constituentsOf(
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly ts.Type[] {
  const apparent = checker.getApparentType(type);
  return apparent.isUnion() ? apparent.types : [apparent];
}

/**
 * Whether the type is an iterator: it has a `next` that answers with something
 * shaped like an `IteratorResult`. The result shape is what keeps an ordinary
 * object with a `next` method — a linked-list node, a parser cursor — from
 * being read as one.
 *
 * An asynchronous iterator answers with a *promise* of one, and is an iterator
 * for every purpose here: one color covers its whole surface too.
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
    .some((signature) => {
      const result = signature.getReturnType();
      return (
        checker.getPropertyOfType(result, "done") !== undefined ||
        hasDone(checker.getAwaitedType(result), checker)
      );
    });
}

function hasDone(type: ts.Type | undefined, checker: ts.TypeChecker): boolean {
  return (
    type !== undefined && checker.getPropertyOfType(type, "done") !== undefined
  );
}

/**
 * The declaration behind a protocol member, bodied or not — a bodyless one is
 * an answer ("the standard library's, and nothing colors it") rather than a
 * missing one.
 */
export function protocolMember(
  type: ts.Type,
  name: ProtocolMemberName,
  checker: ts.TypeChecker,
  async: boolean,
): Bodied | undefined {
  const apparent = checker.getApparentType(type);
  const symbol =
    name === "iterator"
      ? wellKnownIterator(apparent, checker, async)
      : checker.getPropertyOfType(apparent, name);

  // An overloaded member declares itself more than once, and the one that runs
  // is the implementation.
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration !== undefined && ts.isFunctionLike(declaration)
    ? declaration
    : undefined;
}

/**
 * `[Symbol.iterator]` or `[Symbol.asyncIterator]`, found by scanning:
 * TypeScript names well-known symbol members `__@iterator@<id>` with an id that
 * is not ours to predict, so the name cannot be handed to
 * `getPropertyOfType`.
 *
 * A site that wants the asynchronous member falls back to the synchronous one,
 * which is what `for await` does at runtime — it wraps each value of a plain
 * iterable in a promise.
 */
function wellKnownIterator(
  type: ts.Type,
  checker: ts.TypeChecker,
  async: boolean,
): ts.Symbol | undefined {
  const properties = checker.getPropertiesOfType(type);
  const named = (prefix: string): ts.Symbol | undefined =>
    properties.find((property) =>
      String(property.escapedName).startsWith(prefix),
    );

  return async
    ? (named("__@asyncIterator@") ?? named("__@iterator@"))
    : named("__@iterator@");
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

/** Whether a node sits inside an assignment's target rather than a value. */
function isAssignmentTarget(node: ts.Node): boolean {
  for (let child: ts.Node = node; ; child = child.parent) {
    if (assignedTo(child) !== undefined) return true;
    const parent: ts.Node | undefined = child.parent;
    if (
      parent === undefined ||
      (!ts.isArrayLiteralExpression(parent) && !ts.isSpreadElement(parent))
    ) {
      return false;
    }
  }
}

/**
 * What assigns to this node, if anything does: the right-hand side of a
 * destructuring assignment, or a `for…of` whose element it binds and which
 * therefore names no expression.
 */
function assignedTo(
  node: ts.Node,
): { readonly from: ts.Expression | undefined } | undefined {
  const parent: ts.Node | undefined = node.parent;
  if (parent === undefined) return undefined;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === node
  ) {
    return { from: parent.right };
  }
  return ts.isForOfStatement(parent) && parent.initializer === node
    ? { from: undefined }
    : undefined;
}

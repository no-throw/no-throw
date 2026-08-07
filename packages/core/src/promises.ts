import ts from "typescript";
import { skipParens } from "./conditions.js";
import {
  bodyOf,
  hasModifier,
  isGenerator,
  type Bodied,
} from "./declarations.js";
import { constituentsOf } from "./iteration.js";

/**
 * One link of a promise chain: which of `then`/`catch`/`finally` runs, and the
 * handlers it was given. A missing handler and one written as `undefined` or
 * `null` are the same thing at runtime, so both arrive here as absent.
 */
export type ChainLink =
  | {
      readonly kind: "then";
      readonly onFulfilled: ts.Expression | undefined;
      /** Present only where a second handler really discharges the rejection. */
      readonly onRejected: ts.Expression | undefined;
    }
  | { readonly kind: "catch"; readonly onRejected: ts.Expression | undefined }
  | { readonly kind: "finally"; readonly onFinally: ts.Expression | undefined };

/** A chain link with the promise it was written on. */
export interface Chain {
  readonly source: ts.Expression;
  readonly link: ChainLink;
}

/**
 * The chain link a call is, where it is one. The fold is *syntactic*: a chain
 * reached through a binding is a stored partial chain, which floors, so this
 * deliberately reads the receiver as written rather than following it.
 */
export function chainAt(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): Chain | undefined {
  if (!ts.isCallExpression(expression)) return undefined;

  const callee = skipParens(expression.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  const name = callee.name.text;
  if (name !== "then" && name !== "catch" && name !== "finally") return undefined;

  const source = callee.expression;
  if (!isPromiseType(checker.getTypeAtLocation(source), checker)) return undefined;

  // The fold table describes `Promise.prototype`. A thenable whose `then` we
  // can read is an ordinary call, colored by the body that actually runs —
  // folding it would assume semantics the source is right there to contradict.
  const declaration = checker.getResolvedSignature(expression)?.declaration;
  if (
    declaration !== undefined &&
    ts.isFunctionLike(declaration) &&
    bodyOf(declaration) !== undefined
  ) {
    return undefined;
  }

  const [first, second] = expression.arguments;
  if (name === "finally") {
    return { source, link: { kind: "finally", onFinally: handler(first) } };
  }
  if (name === "catch") {
    return { source, link: { kind: "catch", onRejected: handler(first) } };
  }
  return {
    source,
    link: {
      kind: "then",
      onFulfilled: handler(first),
      onRejected: handler(second),
    },
  };
}

/**
 * A handler as the fold sees it. `undefined` and `null` in a handler position
 * are what the language does with a missing one, so reading them as a function
 * would color a link by an argument that never runs.
 */
function handler(argument: ts.Expression | undefined): ts.Expression | undefined {
  if (argument === undefined) return undefined;
  const expression = skipParens(argument);
  if (expression.kind === ts.SyntaxKind.NullKeyword) return undefined;
  return ts.isIdentifier(expression) && expression.text === "undefined"
    ? undefined
    : expression;
}

/**
 * Whether a value is a promise: it has a callable `then`. A union is joined,
 * for the same reason iteration joins one — the value runs whichever surface it
 * turns out to carry.
 */
export function isPromiseType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  return constituentsOf(type, checker).some((constituent) => {
    const then = checker.getPropertyOfType(constituent, "then");
    return (
      then !== undefined &&
      checker.getTypeOfSymbol(then).getCallSignatures().length > 0
    );
  });
}

/**
 * Whether a call to this declaration cannot sync-throw. The `async` keyword is
 * the whole of it: the language turns everything the body does into a rejection
 * of the promise the call hands back.
 *
 * A generator is exempt however it is spelled (#14 §5). Its parameter list is
 * eager — the call runs the defaults before it builds an iterator — so an
 * `async function*` *can* sync-throw, and reading its `async` keyword as the
 * carve-out would lose exactly that.
 */
export function isVisiblyAsync(declaration: Bodied): boolean {
  if (ts.isClassLike(declaration) || isGenerator(declaration)) return false;
  return hasModifier(declaration, ts.SyntaxKind.AsyncKeyword);
}

/**
 * What a statement in expression position actually discards. `void` is written
 * to say "the value is deliberately dropped", which is the same discard the
 * bare form is, so both name the expression underneath.
 */
export function discardedExpression(expression: ts.Expression): ts.Expression {
  let current = skipParens(expression);
  while (ts.isVoidExpression(current)) current = skipParens(current.expression);
  return current;
}

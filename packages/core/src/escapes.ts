import ts from "typescript";
import { bodyOf } from "./declarations.js";

/**
 * A site that transfers control out of the body it is written in: a `throw`,
 * or a call into another body.
 */
export type Escape = ts.ThrowStatement | ts.CallExpression;

/**
 * Every escape site in a body, in source order, minus the ones a bridge
 * neutralizes. One walk serves both consumers: enforcement reports the sites
 * whose callee is throwing, and inference reads the same sites as the edges of
 * the call graph — so the two can never disagree about what a body does.
 */
export function unbridgedEscapes(
  fn: ts.SignatureDeclaration,
): readonly Escape[] {
  const body = bodyOf(fn);
  if (body === undefined) return [];

  const found: Escape[] = [];

  const walk = (node: ts.Node): void => {
    if (isEscape(node) && !isBridged(node)) found.push(node);

    node.forEachChild((child) => {
      // A nested function is its own body with its own color. A class is not
      // body code either: its members are bodies of their own, and evaluating
      // the class — heritage expressions, static blocks, decorators — is ruled
      // out of the color model.
      if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
      walk(child);
    });
  };

  walk(body);
  return found;
}

function isEscape(node: ts.Node): node is Escape {
  return ts.isThrowStatement(node) || ts.isCallExpression(node);
}

/**
 * A `try` with a `catch` neutralizes escapes originating in its try block only;
 * `catch` and `finally` blocks are ordinary body code. Neutralization stops at
 * a function boundary, which the walk never crosses anyway.
 */
function isBridged(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;

  while (parent !== undefined && !ts.isFunctionLike(parent)) {
    if (
      ts.isTryStatement(parent) &&
      parent.catchClause !== undefined &&
      parent.tryBlock === child
    ) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }

  return false;
}

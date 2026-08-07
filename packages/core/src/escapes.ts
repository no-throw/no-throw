import ts from "typescript";
import {
  bodyOf,
  classEvaluation,
  fieldInitializers,
  type Bodied,
} from "./declarations.js";

/**
 * A site that transfers control into some other body, with the syntax naming
 * the callee. Each takes that callee's color and each is bridgeable.
 */
export type Transfer =
  | ts.CallExpression
  | ts.NewExpression
  | ts.TaggedTemplateExpression;

/**
 * A site that transfers control out of the body it is written in: a `throw`,
 * or a transfer into another body.
 */
export type Escape = ts.ThrowStatement | Transfer;

/**
 * The expression naming the callee, wherever the transfer's syntax keeps it.
 * Reading it in one place is what keeps every site that wants to name what is
 * being entered from having to remember the tag/expression difference.
 */
export function calleeExpression(transfer: Transfer): ts.Expression {
  return ts.isTaggedTemplateExpression(transfer)
    ? transfer.tag
    : transfer.expression;
}

/**
 * Every escape site in a body, minus the ones a bridge neutralizes. One walk
 * serves both consumers: enforcement reports the sites whose callee is
 * throwing, and inference reads the same sites as the edges of the call graph —
 * so the two can never disagree about what a body does.
 */
export function unbridgedEscapes(declaration: Bodied): readonly Escape[] {
  const found: Escape[] = [];

  const walk = (node: ts.Node, region: ts.Node): void => {
    if (isEscape(node) && !isBridged(node, region)) found.push(node);

    node.forEachChild((child) => {
      // A nested function is its own body with its own color.
      if (ts.isFunctionLike(child)) return;
      // A class is two things at once. Its member bodies and instance field
      // initializers run on construction, and `new C()` is the escape site
      // that reaches them. Everything else about it runs right here, where the
      // class is written — so it stays in this region and is bridged by
      // whatever bridges the rest of it.
      if (ts.isClassLike(child)) {
        for (const evaluated of classEvaluation(child)) walk(evaluated, region);
        return;
      }
      walk(child, region);
    });
  };

  for (const region of effectiveBody(declaration)) walk(region, region);
  return found;
}

/**
 * The source a call to this declaration runs. A parameter list is eager however
 * lazy the body is — a generator evaluates its defaults before it builds an
 * iterator — and a constructor's effective body reaches the class's field
 * initializers, which are constructor body rather than an escape kind of their
 * own. Both are walked alongside the body itself, so this is one rule with no
 * special case per function kind.
 */
function effectiveBody(declaration: Bodied): readonly ts.Node[] {
  if (ts.isClassLike(declaration)) return fieldInitializers(declaration);

  const regions: ts.Node[] = [];

  for (const parameter of declaration.parameters) {
    // A binding pattern carries defaults of its own, and they are eager too.
    regions.push(parameter.name);
    if (parameter.initializer !== undefined) regions.push(parameter.initializer);
  }
  if (ts.isConstructorDeclaration(declaration)) {
    regions.push(...fieldInitializers(declaration.parent));
  }

  const body = bodyOf(declaration);
  if (body !== undefined) regions.push(body);

  return regions;
}

function isEscape(node: ts.Node): node is Escape {
  return (
    ts.isThrowStatement(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  );
}

/**
 * A `try` with a `catch` neutralizes escapes originating in its try block only;
 * `catch` and `finally` blocks are ordinary body code.
 *
 * Neutralization is bounded by the region the escape was reached through, which
 * is what makes the rule right on both sides of a class: a `try` around a class
 * declaration does bridge the class's static initializers, because those run
 * there, and does not bridge its instance field initializers, because those run
 * wherever someone writes `new C()`. A function boundary needs no test — the
 * walk never crosses one, so no region spans it.
 */
function isBridged(node: ts.Node, region: ts.Node): boolean {
  let child: ts.Node = node;

  while (child !== region) {
    const parent: ts.Node | undefined = child.parent;
    if (parent === undefined) return false;
    if (
      ts.isTryStatement(parent) &&
      parent.catchClause !== undefined &&
      parent.tryBlock === child
    ) {
      return true;
    }
    child = parent;
  }

  return false;
}

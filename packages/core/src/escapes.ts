import ts from "typescript";
import { bodyOf, fieldInitializers, type Bodied } from "./declarations.js";

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
 * Every escape site in a body, minus the ones a bridge neutralizes. One walk
 * serves both consumers: enforcement reports the sites whose callee is
 * throwing, and inference reads the same sites as the edges of the call graph —
 * so the two can never disagree about what a body does.
 */
export function unbridgedEscapes(declaration: Bodied): readonly Escape[] {
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

  for (const region of effectiveBody(declaration)) walk(region);
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
 * `catch` and `finally` blocks are ordinary body code. Neutralization stops at
 * a function boundary, which the walk never crosses anyway, and at a class
 * boundary, which it enters from the outside: a field initializer runs wherever
 * the class is constructed, not where the class is written.
 */
function isBridged(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;

  while (
    parent !== undefined &&
    !ts.isFunctionLike(parent) &&
    !ts.isClassLike(parent)
  ) {
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

import ts from "typescript";

/**
 * The expression→originating-call rule: the call that produced a value, where
 * the syntax says so unambiguously. A direct call is its own origin, and a
 * `const` initialized by a call traces to that call — sound because `const` is
 * single-assignment, and it is what keeps start-early / await-later working.
 *
 * Everything else — `let`, parameters, properties, non-call initializers — has
 * no originating call, and the caller floors. Wider dataflow (`let`
 * meet-over-assignments, ternary initializers) is a deliberate deferral.
 *
 * This is shared machinery rather than one consumer's helper: `await`,
 * generator consumption and condition discharge all ask the same question.
 */
export function originatingCall(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.CallExpression | undefined {
  if (ts.isCallExpression(expression)) return expression;
  if (!ts.isIdentifier(expression)) return undefined;

  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) {
    return undefined;
  }
  if (!isConst(declaration)) return undefined;

  const { initializer } = declaration;
  return initializer !== undefined && ts.isCallExpression(initializer)
    ? initializer
    : undefined;
}

/**
 * A `const` binding, and not a `catch` parameter — which TypeScript also models
 * as a variable declaration, and which nothing initializes.
 */
function isConst(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  return (
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0
  );
}

import ts from "typescript";

/**
 * The declaration's body, or `undefined` where there is none to read a color
 * off: an overload, an interface method, a `.d.ts` declaration, the type of a
 * parameter.
 */
export function bodyOf(
  declaration: ts.SignatureDeclaration,
): ts.Block | ts.Expression | undefined {
  return (declaration as ts.FunctionLikeDeclaration).body;
}

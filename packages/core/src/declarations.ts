import ts from "typescript";

/**
 * Provisional mark detection: a `@nothrow` JSDoc tag as TypeScript attributes
 * it. The normative binding whitelist replaces this.
 */
export function isMarked(node: ts.Node): boolean {
  return ts
    .getJSDocTags(node)
    .some((tag) => tag.tagName.escapedText === "nothrow");
}

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

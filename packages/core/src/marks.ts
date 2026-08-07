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

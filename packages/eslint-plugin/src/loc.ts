import type { Span } from "@no-throw/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type ts from "typescript";

/**
 * The core anchors findings to source offsets, including inside JSDoc, which
 * typescript-eslint never converts to ESTree. Translating offsets here keeps
 * the adapter's dependency on the core down to positions and message data.
 */
export function locOf(
  sourceFile: ts.SourceFile,
  span: Span,
): TSESTree.SourceLocation {
  return {
    start: positionOf(sourceFile, span.start),
    end: positionOf(sourceFile, span.end),
  };
}

/** ESLint counts lines from one and columns from zero; TypeScript, both from zero. */
function positionOf(
  sourceFile: ts.SourceFile,
  offset: number,
): TSESTree.Position {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return { line: line + 1, column: character };
}

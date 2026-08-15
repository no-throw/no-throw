import type { Span } from "@no-throw/core";
import type ts from "typescript";
import type { HostLocation, HostPosition } from "./host.js";

/**
 * The core anchors findings to source offsets, including inside JSDoc.
 * Translating offsets here keeps the adapter's dependency on the core down to
 * positions and message data.
 */
export function locOf(sourceFile: ts.SourceFile, span: Span): HostLocation {
  return {
    start: positionOf(sourceFile, span.start),
    end: positionOf(sourceFile, span.end),
  };
}

/** oxlint counts lines from one and columns from zero; TypeScript, both from zero. */
function positionOf(sourceFile: ts.SourceFile, offset: number): HostPosition {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return { line: line + 1, column: character };
}

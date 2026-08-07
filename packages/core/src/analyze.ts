import ts from "typescript";
import { findMarks, type Span } from "./marks.js";

/**
 * The kinds of escape a marked function can be reported for. Every kind is a
 * facet of the one invariant, so adapters surface them inside a single rule
 * rather than as separate, individually disableable ones.
 */
export type FindingKind = "uncaught-throw";

export interface Finding {
  readonly kind: FindingKind;
  readonly span: Span;
}

/**
 * Collect every escape in a file. The core never builds a `ts.Program`: hosts
 * hand it source files off the program they already own, which is how the
 * ESLint adapter reuses the one typescript-eslint built.
 */
export function analyzeSourceFile(
  sourceFile: ts.SourceFile,
): readonly Finding[] {
  const findings: Finding[] = [];

  // Unmarked functions have nothing to enforce: throwing is the default. A
  // mark that does not bind enforces nothing either — it is `valid-mark`'s to
  // report, not an invariant this walk can hold anything to.
  for (const { target } of findMarks(sourceFile).bound) {
    collectEscapes(target, sourceFile, findings);
  }

  return findings;
}

function collectEscapes(
  fn: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  out: Finding[],
): void {
  const { body } = fn;
  if (body === undefined) return;

  const walk = (node: ts.Node): void => {
    if (ts.isThrowStatement(node) && !isBridged(node)) {
      out.push({
        kind: "uncaught-throw",
        span: { start: node.getStart(sourceFile), end: node.getEnd() },
      });
    }

    node.forEachChild((child) => {
      // A nested function is its own body with its own color, and module
      // evaluation — where `static {}` and `extends` expressions run — is
      // outside the color model entirely.
      if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
      walk(child);
    });
  };

  walk(body);
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

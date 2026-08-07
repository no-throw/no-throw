import ts from "typescript";
import type { FloorReason } from "./colors.js";
import { unbridgedEscapes } from "./escapes.js";
import { findMarks } from "./marks.js";
import { createColorResolver } from "./resolve-color.js";

interface UncaughtThrow {
  readonly kind: "uncaught-throw";
  /** The node the diagnostic is anchored to. */
  readonly node: ts.Node;
}

interface UnbridgedCall {
  readonly kind: "unbridged-call";
  readonly node: ts.Node;
  /** The callee as written, so the message can name what to bridge. */
  readonly callee: string;
  readonly reason: FloorReason;
}

/** A call whose callee was read rather than floored, and can throw. */
interface InferredThrowingCall {
  readonly kind: "inferred-throwing-call";
  readonly node: ts.Node;
  readonly callee: string;
}

/**
 * The escapes a marked function can be reported for. Every kind is a facet of
 * the one invariant, so adapters surface them inside a single rule rather than
 * as separate, individually disableable ones.
 */
export type Finding = UncaughtThrow | UnbridgedCall | InferredThrowingCall;

/**
 * Collect every escape in a file. The core never builds a `ts.Program`: hosts
 * hand it source files and the checker off the program they already own, which
 * is how the ESLint adapter reuses the one typescript-eslint built.
 */
export function analyzeSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): readonly Finding[] {
  const findings: Finding[] = [];
  // The inference memo lives as long as one file's analysis. Sharing it across
  // a program is the incrementality question the dogfooding gate prices.
  const colors = createColorResolver(checker);

  // Unmarked functions have nothing to enforce: throwing is the default, and
  // inference reads their bodies without holding them to anything. A mark that
  // binds to nothing enforces nothing either — it is `valid-mark`'s to report.
  for (const target of findMarks(sourceFile).bound) {
    for (const escape of unbridgedEscapes(target)) {
      if (ts.isThrowStatement(escape)) {
        findings.push({ kind: "uncaught-throw", node: escape });
        continue;
      }

      const callee = colors.at(escape);
      if (callee.color === "non-throwing") continue;

      findings.push(
        callee.reason === "inferred"
          ? {
              kind: "inferred-throwing-call",
              node: escape,
              callee: calleeText(escape),
            }
          : {
              kind: "unbridged-call",
              node: escape,
              callee: calleeText(escape),
              reason: callee.reason,
            },
      );
    }
  }

  return findings;
}

function calleeText(call: ts.CallExpression): string {
  return call.expression.getText().replace(/\s+/gu, " ");
}

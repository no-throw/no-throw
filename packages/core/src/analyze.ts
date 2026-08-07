import ts from "typescript";
import type { FloorReason } from "./colors.js";
import { bodyOf } from "./declarations.js";
import { findMarks } from "./marks.js";
import { resolveCalleeColor } from "./resolve-color.js";

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

/**
 * The escapes a marked function can be reported for. Every kind is a facet of
 * the one invariant, so adapters surface them inside a single rule rather than
 * as separate, individually disableable ones.
 */
export type Finding = UncaughtThrow | UnbridgedCall;

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

  // Unmarked functions have nothing to enforce: throwing is the default. A mark
  // that binds to nothing enforces nothing either — it is `valid-mark`'s to
  // report, not an invariant this walk can hold anything to.
  for (const target of findMarks(sourceFile).bound) {
    collectEscapes(target, checker, findings);
  }

  return findings;
}

function collectEscapes(
  fn: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  out: Finding[],
): void {
  const body = bodyOf(fn);
  if (body === undefined) return;

  const walk = (node: ts.Node): void => {
    if (ts.isThrowStatement(node) && !isBridged(node)) {
      out.push({ kind: "uncaught-throw", node });
    }

    if (ts.isCallExpression(node) && !isBridged(node)) {
      const callee = resolveCalleeColor(node, checker);
      if (callee.color === "throwing") {
        out.push({
          kind: "unbridged-call",
          node,
          callee: calleeText(node),
          reason: callee.reason,
        });
      }
    }

    node.forEachChild((child) => {
      // A nested function is its own body with its own color. A class is not
      // body code either: its members are bodies of their own, and evaluating
      // the class — heritage expressions, static blocks, decorators — is ruled
      // out of the color model.
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

function calleeText(call: ts.CallExpression): string {
  return call.expression.getText().replace(/\s+/gu, " ");
}

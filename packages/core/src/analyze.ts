import ts from "typescript";
import type { ConsumptionReason, FloorReason } from "./colors.js";
import {
  inheritedFrom,
  isGenerator,
  returnedExpressions,
} from "./declarations.js";
import { calleeExpression, unbridgedEscapes, type Transfer } from "./escapes.js";
import { isIteratorType } from "./iteration.js";
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

/** A `for…of`, spread, destructuring, `.next()` or `yield*` that can throw. */
interface ThrowingConsumption {
  readonly kind: "throwing-consumption";
  readonly node: ts.Node;
  readonly reason: ConsumptionReason;
}

/** `.throw()`: the consumer throwing, with a detour through the iterator. */
interface IteratorThrow {
  readonly kind: "iterator-throw";
  readonly node: ts.Node;
}

/** A returned iterator whose consumption the mark cannot be held to. */
interface ThrowingReturnedIterator {
  readonly kind: "throwing-returned-iterator";
  readonly node: ts.Node;
  readonly reason: ConsumptionReason;
}

/**
 * The escapes a marked function can be reported for. Every kind is a facet of
 * the one invariant, so adapters surface them inside a single rule rather than
 * as separate, individually disableable ones.
 */
export type Finding =
  | UncaughtThrow
  | UnbridgedCall
  | InferredThrowingCall
  | ThrowingConsumption
  | IteratorThrow
  | ThrowingReturnedIterator;

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
    for (const escape of unbridgedEscapes(target, checker)) {
      if (escape.kind === "throw") {
        findings.push({ kind: "uncaught-throw", node: escape.node });
        continue;
      }

      if (escape.kind === "transfer") {
        const callee = colors.at(escape.node);
        if (callee.color === "non-throwing") continue;

        findings.push(
          callee.reason === "inferred"
            ? {
                kind: "inferred-throwing-call",
                node: escape.node,
                callee: calleeText(escape.node),
              }
            : {
                kind: "unbridged-call",
                node: escape.node,
                callee: calleeText(escape.node),
                reason: callee.reason,
              },
        );
        continue;
      }

      if (escape.kind === "iterator-throw") {
        findings.push({ kind: "iterator-throw", node: escape.node });
        continue;
      }

      const consumed = colors.consuming(escape.site);
      if (consumed.color === "throwing") {
        findings.push({
          kind: "throwing-consumption",
          node: escape.site.node,
          reason: consumed.reason,
        });
      }
    }

    for (const returned of returnedIterators(target, checker)) {
      const produced = colors.producing(returned);
      if (produced.color === "throwing") {
        findings.push({
          kind: "throwing-returned-iterator",
          node: returned,
          reason: produced.reason,
        });
      }
    }
  }

  return findings;
}

/**
 * The iterators a marked function hands out, which its mark covers consuming —
 * so a mark on a plain function that returns one it cannot trace to a clean
 * producer is refused, per the doctrine that unprovable is not clean. A
 * generator needs no such check: its iterator *is* the body already walked.
 */
function returnedIterators(
  declaration: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): readonly ts.Expression[] {
  if (isGenerator(declaration)) return [];
  return returnedExpressions(declaration).filter((expression) =>
    isIteratorType(checker.getTypeAtLocation(expression), checker),
  );
}

/**
 * What the message calls the callee. `super` is the one transfer whose syntax
 * names nothing a reader could act on — the mark that would make it clean goes
 * on the base class — so a super call is quoted by the class it enters.
 */
function calleeText(transfer: Transfer): string {
  const callee = calleeExpression(transfer);
  const named =
    callee.kind === ts.SyntaxKind.SuperKeyword
      ? (inheritedFrom(transfer) ?? callee)
      : callee;
  return named.getText().replace(/\s+/gu, " ");
}

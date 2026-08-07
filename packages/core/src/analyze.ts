import ts from "typescript";
import type { FloorReason, UndischargedReason } from "./colors.js";
import { describePath, type Condition } from "./conditions.js";
import { inheritedFrom } from "./declarations.js";
import { calleeExpression, type Transfer } from "./escapes.js";
import { findMarks } from "./marks.js";
import { createColorResolver, type BodyEscape } from "./resolve-color.js";
import { textOf, type HiddenCallee, type TransferSite } from "./transfers.js";

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
 * Where a body enters a condition path. Naming it is half of what a
 * discharge-failure diagnostic owes the reader: the parameter alone does not
 * say which line to look at.
 */
export interface EntrySite {
  readonly fileName: string;
  /** One-based, so the adapter can print it without knowing about offsets. */
  readonly line: number;
}

interface ConditionArgument {
  readonly node: ts.Node;
  readonly callee: string;
  /** The path as the callee's author wrote it: `cb`, `repo.save`. */
  readonly path: string;
  readonly entry: EntrySite;
}

/** The condition resolved to something whose body was read and can throw. */
interface ThrowingConditionArgument extends ConditionArgument {
  readonly kind: "throwing-condition-argument";
}

interface FlooredConditionArgument extends ConditionArgument {
  readonly kind: "floored-condition-argument";
  readonly reason: UndischargedReason;
}

/**
 * A body that runs with no callee in the syntax: an accessor behind a property
 * access, a conversion member behind a coercion. Its own kind because what the
 * reader has to be told is different — not "this call throws" but "this is a
 * call".
 */
interface HiddenTransfer {
  readonly node: ts.Node;
  readonly site: TransferSite;
  /** The site as written. */
  readonly text: string;
  /** Absent when the type could not name what runs, which always floors. */
  readonly target: HiddenCallee | undefined;
}

interface UnbridgedHiddenTransfer extends HiddenTransfer {
  readonly kind: "unbridged-hidden-transfer";
  readonly reason: FloorReason;
}

interface InferredThrowingHiddenTransfer extends HiddenTransfer {
  readonly kind: "inferred-throwing-hidden-transfer";
  readonly target: HiddenCallee;
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
  | ThrowingConditionArgument
  | FlooredConditionArgument
  | UnbridgedHiddenTransfer
  | InferredThrowingHiddenTransfer;

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
  for (const seed of findMarks(sourceFile).bound) {
    for (const escape of colors.escapesIn(seed)) {
      findings.push(findingFor(escape));
    }
  }

  return findings;
}

function findingFor(escape: BodyEscape): Finding {
  switch (escape.kind) {
    case "throw":
      return { kind: "uncaught-throw", node: escape.node };
    case "callee":
      return escape.reason === "inferred"
        ? {
            kind: "inferred-throwing-call",
            node: escape.node,
            callee: calleeText(escape.node),
          }
        : {
            kind: "unbridged-call",
            node: escape.node,
            callee: calleeText(escape.node),
            reason: escape.reason,
          };
    case "argument-throwing":
      return {
        kind: "throwing-condition-argument",
        ...conditionArgument(escape.node, escape.condition),
      };
    case "argument-floored":
      return {
        kind: "floored-condition-argument",
        reason: escape.reason,
        ...conditionArgument(escape.node, escape.condition),
      };
    case "hidden-transfer": {
      const { node, site, text, target } = escape;
      // A transfer the type could not name has no body anything could have
      // read, so it is a floor however it got here.
      if (target === undefined) {
        return {
          kind: "unbridged-hidden-transfer",
          node,
          site,
          text,
          target,
          reason: "unresolvable",
        };
      }
      return escape.reason === "inferred"
        ? { kind: "inferred-throwing-hidden-transfer", node, site, text, target }
        : {
            kind: "unbridged-hidden-transfer",
            node,
            site,
            text,
            target,
            reason: escape.reason,
          };
    }
  }
}

function conditionArgument(
  site: Transfer,
  condition: Condition,
): ConditionArgument {
  return {
    node: site,
    callee: calleeText(site),
    path: describePath(condition.path, condition.owner),
    entry: entrySiteOf(condition),
  };
}

function entrySiteOf(condition: Condition): EntrySite {
  const sourceFile = condition.entry.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    condition.entry.getStart(sourceFile),
  );
  return { fileName: sourceFile.fileName, line: line + 1 };
}

/**
 * What the message calls the callee. `super` is the one transfer whose syntax
 * names nothing a reader could act on — the mark that would make it clean goes
 * on the base class — so a super call is quoted by the class it enters.
 */
function calleeText(transfer: Transfer): string {
  const callee = calleeExpression(transfer);
  return textOf(
    callee.kind === ts.SyntaxKind.SuperKeyword
      ? (inheritedFrom(transfer) ?? callee)
      : callee,
  );
}

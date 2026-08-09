import ts from "typescript";
import type {
  ConsumptionReason,
  FloorReason,
  Rejects,
  UndischargedReason,
} from "./colors.js";
import { createCarrier } from "./carrier/chain.js";
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
  /** The file whose hash drifted; only `stale-manifest` carries one. */
  readonly staleFile?: string | undefined;
}

/** A call whose callee was read rather than floored, and can throw. */
interface InferredThrowingCall {
  readonly kind: "inferred-throwing-call";
  readonly node: ts.Node;
  readonly callee: string;
}

/**
 * The same, where what was read is a class that declares no constructor. Its
 * own kind because the out differs and the usual one is a dead end: there is no
 * declaration for a mark to bind to, so the reader has to write the constructor
 * before they can claim anything about it.
 */
interface InferredThrowingConstruction {
  readonly kind: "inferred-throwing-construction";
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
  /**
   * Where the callee's body enters the path — absent where a carrier stated
   * the condition, since there is no body that enters anything.
   */
  readonly entry: EntrySite | undefined;
}

/** The condition resolved to something whose body was read and can throw. */
interface ThrowingConditionArgument extends ConditionArgument {
  readonly kind: "throwing-condition-argument";
}

interface FlooredConditionArgument extends ConditionArgument {
  readonly kind: "floored-condition-argument";
  readonly reason: UndischargedReason;
  readonly staleFile?: string | undefined;
}

/** A `for…of`, spread, destructuring, `.next()` or `yield*` that can throw. */
interface ThrowingConsumption {
  readonly kind: "throwing-consumption";
  readonly node: ts.Node;
  readonly reason: ConsumptionReason;
  readonly staleFile?: string | undefined;
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
  readonly staleFile?: string | undefined;
}

/**
 * A rejection reaching a marked body. The three kinds are the three places a
 * promise's own channel is consumed, and each is told something different: an
 * `await` turns a rejection into a throw here, a discard lets it reach nobody
 * at all, and a `return` hands it to the caller under this function's mark.
 */
interface RejectedAwait {
  readonly kind: "rejected-await";
  readonly node: ts.Node;
  /** The awaited expression as written. */
  readonly expression: string;
  readonly rejects: Rejects;
}

interface FloatingRejection {
  readonly kind: "floating-rejection";
  readonly node: ts.Node;
  readonly expression: string;
  readonly rejects: Rejects;
  /** The discard sits in a `try`/`catch` whose `catch` can never fire. */
  readonly fake: boolean;
}

interface RejectedReturn {
  readonly kind: "rejected-return";
  readonly node: ts.Node;
  readonly rejects: Rejects;
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
  readonly staleFile?: string | undefined;
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
  | InferredThrowingConstruction
  | ThrowingConditionArgument
  | FlooredConditionArgument
  | ThrowingConsumption
  | IteratorThrow
  | ThrowingReturnedIterator
  | RejectedAwait
  | FloatingRejection
  | RejectedReturn
  | UnbridgedHiddenTransfer
  | InferredThrowingHiddenTransfer;

/**
 * Collect every escape in a file. The core never builds a `ts.Program`: hosts
 * hand it the one they already own, which is how the ESLint adapter reuses the
 * program typescript-eslint built. The program rather than the checker alone,
 * because a package's published surface is read from its entry-point files —
 * which are files, not types.
 */
export function analyzeSourceFile(
  sourceFile: ts.SourceFile,
  program: ts.Program,
): readonly Finding[] {
  const findings: Finding[] = [];
  const checker = program.getTypeChecker();
  // The inference memo lives as long as one file's analysis. Sharing it across
  // a program is the incrementality question the dogfooding gate prices.
  //
  // The carrier is built per file because the chain's first question is which
  // package is asking: your own bodyless declarations are the authoring side,
  // where an unverified assertion belongs in the overrides channel.
  const colors = createColorResolver({
    checker,
    carrier: createCarrier(sourceFile, program),
  });

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
            kind:
              escape.constructorless === true
                ? "inferred-throwing-construction"
                : "inferred-throwing-call",
            node: escape.node,
            callee: calleeText(escape.node),
          }
        : {
            kind: "unbridged-call",
            node: escape.node,
            callee: calleeText(escape.node),
            reason: escape.reason,
            staleFile: escape.staleFile,
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
        staleFile: escape.staleFile,
        ...conditionArgument(escape.node, escape.condition),
      };
    case "consumption":
      return {
        kind: "throwing-consumption",
        node: escape.node,
        reason: escape.reason,
        staleFile: escape.staleFile,
      };
    case "iterator-throw":
      return { kind: "iterator-throw", node: escape.node };
    case "returned-iterator":
      return {
        kind: "throwing-returned-iterator",
        node: escape.node,
        reason: escape.reason,
        staleFile: escape.staleFile,
      };
    case "rejected-await":
      return {
        kind: "rejected-await",
        node: escape.node,
        // The `await` is the site; what the reader has to see named is what
        // they wrote after it.
        expression: textOf((escape.node as ts.AwaitExpression).expression),
        rejects: escape.rejects,
      };
    case "float":
      return {
        kind: "floating-rejection",
        node: escape.node,
        expression: textOf(escape.node),
        rejects: escape.rejects,
        fake: escape.fake,
      };
    case "rejected-return":
      return {
        kind: "rejected-return",
        node: escape.node,
        rejects: escape.rejects,
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
            staleFile: escape.staleFile,
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

function entrySiteOf(condition: Condition): EntrySite | undefined {
  if (condition.entry === undefined) return undefined;
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

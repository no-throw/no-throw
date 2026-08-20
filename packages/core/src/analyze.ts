import ts from "typescript";
import type {
  AbsenceReason,
  ConsumptionReason,
  FloorReason,
  FloorSource,
  Rejects,
  UndischargedReason,
} from "./colors.js";
import { createCarrier } from "./carrier/chain.js";
import { describePath, skipParens, type Condition } from "./conditions.js";
import { inheritedFrom } from "./declarations.js";
import { calleeExpression, type Transfer } from "./escapes.js";
import { findMarks, type Span } from "./marks.js";
import { createColorResolver, type BodyEscape } from "./resolve-color.js";
import { textOf, type HiddenCallee, type TransferSite } from "./transfers.js";
import type { TypeFacts } from "./type-facts.js";
import { typeFactsOf } from "./type-facts/typescript.js";

/**
 * Where a finding lands, which is two places rather than one. `node` is the
 * escape site — what a bridge wraps, and what an adapter maps back to its own
 * tree. `anchor` is where the caret goes, and the two part company wherever the
 * escape is about one member of a larger expression: `s.trim().padEnd(5, "-")`
 * is a single node starting at `s`, which is the one token in it that is not
 * implicated.
 */
interface Anchored {
  readonly node: ts.Node;
  readonly anchor: Span;
}

interface UncaughtThrow extends Anchored {
  readonly kind: "uncaught-throw";
}

interface UnbridgedCall extends Anchored {
  readonly kind: "unbridged-call";
  /** The callee as written, so the message can name what to bridge. */
  readonly callee: string;
  readonly reason: FloorReason;
  /** The file whose hash drifted; only `stale-manifest` carries one. */
  readonly staleFile?: string | undefined;
  /**
   * Where the callee's declaration lives, which decides which of the floor's
   * outs a message may honestly name. Absent means an ordinary package.
   */
  readonly source?: FloorSource | undefined;
}

/** A call whose callee was read rather than floored, and can throw. */
interface InferredThrowingCall extends Anchored {
  readonly kind: "inferred-throwing-call";
  readonly callee: string;
}

/**
 * The same, where what was read is a class that declares no constructor. Its
 * own kind because the out differs and the usual one is a dead end: there is no
 * declaration for a mark to bind to, so the reader has to write the constructor
 * before they can claim anything about it.
 */
interface InferredThrowingConstruction extends Anchored {
  readonly kind: "inferred-throwing-construction";
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

interface ConditionArgument extends Anchored {
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
  readonly source?: FloorSource | undefined;
}

/**
 * The condition asked for no argument at the position and got one. Its own
 * kind rather than one more reason on the two above, because the sentence it
 * has to be told is the opposite one: stop passing, rather than pass something
 * clean. Only a carrier can state the condition, so there is no `entry` half to
 * this one either.
 */
interface UnwantedConditionArgument extends ConditionArgument {
  readonly kind: "unwanted-condition-argument";
  readonly reason: AbsenceReason;
  /** The *callee's* declaration: it is the call that has to change. */
  readonly source?: FloorSource | undefined;
}

/** A `for…of`, spread, destructuring, `.next()` or `yield*` that can throw. */
interface ThrowingConsumption extends Anchored {
  readonly kind: "throwing-consumption";
  readonly reason: ConsumptionReason;
  readonly staleFile?: string | undefined;
  readonly source?: FloorSource | undefined;
}

/** `.throw()`: the consumer throwing, with a detour through the iterator. */
interface IteratorThrow extends Anchored {
  readonly kind: "iterator-throw";
}

/** A returned iterator whose consumption the mark cannot be held to. */
interface ThrowingReturnedIterator extends Anchored {
  readonly kind: "throwing-returned-iterator";
  readonly reason: ConsumptionReason;
  readonly staleFile?: string | undefined;
  readonly source?: FloorSource | undefined;
}

/**
 * A rejection reaching a marked body. The three kinds are the three places a
 * promise's own channel is consumed, and each is told something different: an
 * `await` turns a rejection into a throw here, a discard lets it reach nobody
 * at all, and a `return` hands it to the caller under this function's mark.
 */
interface RejectedAwait extends Anchored {
  readonly kind: "rejected-await";
  /** The awaited expression as written. */
  readonly expression: string;
  readonly rejects: Rejects;
}

interface FloatingRejection extends Anchored {
  readonly kind: "floating-rejection";
  readonly expression: string;
  readonly rejects: Rejects;
  /** The discard sits in a `try`/`catch` whose `catch` can never fire. */
  readonly fake: boolean;
}

interface RejectedReturn extends Anchored {
  readonly kind: "rejected-return";
  readonly rejects: Rejects;
}

/**
 * A body that runs with no callee in the syntax: an accessor behind a property
 * access, a conversion member behind a coercion. Its own kind because what the
 * reader has to be told is different — not "this call throws" but "this is a
 * call".
 */
interface HiddenTransfer extends Anchored {
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
  readonly source?: FloorSource | undefined;
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
  | UnwantedConditionArgument
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
  /**
   * Where the type answers come from, for a host whose checker is not the
   * program's own — a TypeScript 7 client, or an instrumented one. Hosts that
   * have a `ts.Program` and nothing else omit it and get the program's checker,
   * which is every consumer today.
   */
  facts: TypeFacts = typeFactsOf(program.getTypeChecker()),
): readonly Finding[] {
  const findings: Finding[] = [];
  // The inference memo lives as long as one file's analysis. Sharing it across
  // a program is the incrementality question the dogfooding gate prices.
  //
  // The carrier is built per file because the chain's first question is which
  // package is asking: your own bodyless declarations are the authoring side,
  // where an unverified assertion belongs in the overrides channel.
  const colors = createColorResolver({
    facts,
    carrier: createCarrier(sourceFile, program, facts),
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
      return { kind: "uncaught-throw", ...anchoredAt(escape.node) };
    case "callee":
      return escape.reason === "inferred"
        ? {
            kind:
              escape.constructorless === true
                ? "inferred-throwing-construction"
                : "inferred-throwing-call",
            ...calleeSite(escape.node),
          }
        : {
            kind: "unbridged-call",
            ...calleeSite(escape.node),
            reason: escape.reason,
            staleFile: escape.staleFile,
            source: escape.source,
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
        source: escape.source,
        ...conditionArgument(escape.node, escape.condition),
      };
    case "argument-present":
      return {
        kind: "unwanted-condition-argument",
        reason: escape.reason,
        source: escape.source,
        ...conditionArgument(escape.node, escape.condition),
      };
    case "consumption":
      return {
        kind: "throwing-consumption",
        ...anchoredAt(escape.node),
        reason: escape.reason,
        staleFile: escape.staleFile,
        source: escape.source,
      };
    case "iterator-throw":
      return { kind: "iterator-throw", ...anchoredAt(escape.node) };
    case "returned-iterator":
      return {
        kind: "throwing-returned-iterator",
        ...anchoredAt(escape.node),
        reason: escape.reason,
        staleFile: escape.staleFile,
        source: escape.source,
      };
    case "rejected-await":
      return {
        kind: "rejected-await",
        ...anchoredAt(escape.node),
        // The `await` is the site; what the reader has to see named is what
        // they wrote after it.
        expression: textOf((escape.node as ts.AwaitExpression).expression),
        rejects: escape.rejects,
      };
    case "float":
      return {
        kind: "floating-rejection",
        ...anchoredAt(escape.node),
        expression: textOf(escape.node),
        rejects: escape.rejects,
        fake: escape.fake,
      };
    case "rejected-return":
      return {
        kind: "rejected-return",
        ...anchoredAt(escape.node),
        rejects: escape.rejects,
      };
    case "hidden-transfer": {
      const { node, site, text, target } = escape;
      // The text keeps the whole expression — "Reading `getBox().value`" is
      // what a reader wrote, and the receiver is what makes that sentence
      // locate anything — while the caret narrows to the member whose accessor
      // runs. The anchor isolates; the text contextualizes.
      const where = anchoredAt(
        node,
        pointsAtTheMember[site] ? nameOf(node) : node,
      );
      // A transfer the type could not name has no body anything could have
      // read, so it is a floor however it got here.
      if (target === undefined) {
        return {
          kind: "unbridged-hidden-transfer",
          ...where,
          site,
          text,
          target,
          reason: "unresolvable",
        };
      }
      return escape.reason === "inferred"
        ? {
            kind: "inferred-throwing-hidden-transfer",
            ...where,
            site,
            text,
            target,
          }
        : {
            kind: "unbridged-hidden-transfer",
            ...where,
            site,
            text,
            target,
            reason: escape.reason,
            staleFile: escape.staleFile,
            source: escape.source,
          };
    }
  }
}

function conditionArgument(
  site: Transfer,
  condition: Condition,
): ConditionArgument {
  return {
    ...calleeSite(site),
    path: describePath(condition.path, condition.owner),
    entry: entrySiteOf(condition),
  };
}

/**
 * Whether one member is the body a hidden transfer enters, said per site so a
 * new one has to answer rather than inherit an answer. A read, a write and an
 * update each run one member's accessor, and that member is what the caret
 * belongs on. The rest reach something the *value* carries — a coercion runs a
 * conversion member, a spread every own enumerable getter, an `instanceof` a
 * declared `Symbol.hasInstance` — so the value is the subject whole, and
 * narrowing to its last member would point at a token nothing was said about.
 * A destructuring element is written as narrowly as the syntax allows already:
 * it names its member rather than reaching one through a chain.
 */
const pointsAtTheMember: Record<TransferSite, boolean> = {
  read: true,
  write: true,
  update: true,
  coercion: false,
  spread: false,
  destructure: false,
  "instance-check": false,
};

/** An escape site whose caret sits somewhere inside it, or on all of it. */
function anchoredAt(node: ts.Node, anchor: ts.Node = node): Anchored {
  return { node, anchor: { start: anchor.getStart(), end: anchor.getEnd() } };
}

/**
 * Where a call's diagnostic points and what it calls the callee, read as one
 * answer so the caret and the quote can never disagree about which member is
 * implicated.
 *
 * `super` is the one transfer whose syntax names nothing a reader could act on
 * — the mark that would make it clean goes on the base class — so a super call
 * is quoted by the class it enters, and there alone the two part company,
 * because that class is written somewhere else.
 */
function calleeSite(
  transfer: Transfer,
): Anchored & { readonly callee: string } {
  const callee = calleeExpression(transfer);
  const name = nameOf(callee);
  return {
    ...anchoredAt(transfer, name),
    callee: textOf(
      callee.kind === ts.SyntaxKind.SuperKeyword
        ? (inheritedFrom(transfer) ?? callee)
        : name,
    ),
  };
}

/**
 * How much of a member expression is a *name*: the longest suffix of the chain
 * whose receiver a reader could still write down. `JSON.parse` is a name all the
 * way down, and so is `config.io.read`; in `s.trim().slice(0, 3).padEnd` a call
 * intervenes, so everything left of `padEnd` is a value some call produced
 * rather than something anyone could act on, and `padEnd` is the whole of what
 * can be named.
 *
 * A chain is one node beginning at its receiver, so a diagnostic pointed at the
 * node points at `s` — the one token on the line that is not implicated. This
 * is what it points at instead, and the reason the answer is not simply the
 * member is the CI log: a floor has to be actionable from that line alone, and
 * `parse` on its own would be less than the reader had before.
 *
 * A member reached through brackets is left whole, receiver and all. `o[k]`
 * names its member with an expression rather than a token, and where the key is
 * not a literal the site joins over every member the receiver has (#29 §6), so
 * there is nothing single in it to point at or to quote.
 */
function nameOf(node: ts.Node): ts.Node {
  if (!ts.isPropertyAccessExpression(node)) return node;
  return isNamed(node.expression) ? node : node.name;
}

/**
 * Whether a receiver is written as a name rather than computed as a value.
 * Parentheses are read through, as everywhere else a chain is walked: `(a).b`
 * is the name `a.b` with punctuation in it.
 */
function isNamed(expression: ts.Expression): boolean {
  const inner = skipParens(expression);
  if (
    ts.isIdentifier(inner) ||
    inner.kind === ts.SyntaxKind.ThisKeyword ||
    inner.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return true;
  }
  return ts.isPropertyAccessExpression(inner) && isNamed(inner.expression);
}

function entrySiteOf(condition: Condition): EntrySite | undefined {
  if (condition.entry === undefined) return undefined;
  const sourceFile = condition.entry.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    condition.entry.getStart(sourceFile),
  );
  return { fileName: sourceFile.fileName, line: line + 1 };
}

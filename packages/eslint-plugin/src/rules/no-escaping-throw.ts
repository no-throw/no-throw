import {
  analyzeSourceFile,
  type EntrySite,
  type Finding,
  type FloorReason,
  type Target,
  type TransferSite,
  type UndischargedReason,
} from "@nothrow/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { relative, sep } from "node:path";
import type ts from "typescript";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/MidnightDesign/no-throw#${name}`,
);

/**
 * The outs a floor must name, in precedence order. They live in the message
 * text and never behind a docs URL: the CI log is the channel that survives
 * into code review, and acting on a floor from it alone is the whole contract.
 */
const OUTS =
  "Your outs, in precedence order: bridge this call with `try`/`catch`; " +
  "assert the color in `nothrow.overrides.json`; install or write an " +
  "`@nothrow/*` overlay; or, if you own the package, ship a manifest with " +
  "`nothrow emit`.";

const messages = {
  uncaughtThrow: "Uncaught `throw` escapes this `@nothrow` function.",
  unbridgedCall:
    "Call to `{{callee}}` escapes this `@nothrow` function: it {{reason}}. " +
    OUTS,
  // Not a floor, so not the floor's outs: the body was read and it can throw,
  // and every carrier on that list would be silencing a true positive.
  inferredThrowingCall:
    "Call to `{{callee}}` escapes this `@nothrow` function: its body was " +
    "analyzed and can throw. Your outs: bridge this call with `try`/`catch`, " +
    "or make `{{callee}}` non-throwing — mark it `@nothrow` and the escapes " +
    "inside it are reported too.",
  // A conditioned callee is clean given a path over its own parameters, so a
  // failure names the path, where the callee's body enters it, and the outs.
  conditionArgumentThrowing:
    "Call to `{{callee}}` escapes this `@nothrow` function: it is non-throwing " +
    "given `{{path}}`, and the argument passed for `{{path}}` is throwing — " +
    "its body was analyzed and can throw. `{{callee}}` enters `{{path}}` at " +
    "{{entry}}. Your outs: bridge this call with `try`/`catch`, or pass " +
    "something non-throwing for `{{path}}`.",
  conditionArgumentFloored:
    "Call to `{{callee}}` escapes this `@nothrow` function: it is non-throwing " +
    "given `{{path}}`, and {{reason}}. `{{callee}}` enters `{{path}}` at " +
    "{{entry}}. " + OUTS,
  // Its own pair, because the first thing the reader needs told is that this
  // *is* a call: they did not write one, and the message has to say what runs.
  unbridgedHiddenTransfer:
    "{{site}} escapes this `@nothrow` function: {{reason}}. " + OUTS,
  inferredThrowingHiddenTransfer:
    "{{site}} escapes this `@nothrow` function: it runs {{target}}, whose " +
    "body was analyzed and can throw. Your outs: bridge it with " +
    "`try`/`catch`, or make {{target}} non-throwing — mark it `@nothrow` and " +
    "the escapes inside it are reported too.",
} as const;

type MessageId = keyof typeof messages;

/**
 * The why half of the two-clause floor contract, as a predicate: the call
 * messages make the callee its subject, the hidden-transfer ones the member
 * that runs. One record, so the normative text cannot drift between them.
 */
const whyFloored: Record<FloorReason, string> = {
  bodyless:
    "is declared without a body — an ambient declaration, a `.d.ts`, or a " +
    "value known only by its function type — and no mark, manifest, overlay " +
    "or override colors it, so it is assumed to throw",
  unmarked:
    "has a visible body but no `@nothrow` mark, so it is throwing by " +
    "declaration",
  unresolvable:
    "cannot be resolved to a declaration by the checker, so nothing can say " +
    "whether it throws",
  captured:
    "is captured from an enclosing scope rather than reached through a " +
    "parameter of this function, so no argument at any call site could " +
    "discharge a condition on it",
  "mutable-binding":
    "is reached through a `let`, whose value the engine does not yet track " +
    "across assignments, so which function runs here is not settled",
  conditioned:
    "is non-throwing only given conditions of its own, and this site reaches " +
    "it through a type rather than handing it anything, so there is no " +
    "argument here that could discharge them",
};

/** The same contract for the argument that was supposed to discharge a path. */
const whyUndischarged: Record<UndischargedReason, string> = {
  bodyless:
    "the argument passed for it is declared without a body — an ambient " +
    "declaration, a `.d.ts`, or an interface member — and no mark, manifest, " +
    "overlay or override colors it",
  unmarked:
    "the argument passed for it has a visible body but no `@nothrow` mark, so " +
    "it is throwing by declaration",
  unresolvable:
    "the argument passed for it does not resolve to a function this engine " +
    "can color, so nothing can say whether it throws",
  captured:
    "the argument passed for it comes from an enclosing function's parameter, " +
    "which is unknowable from here",
  "mutable-binding":
    "the argument passed for it is a `let`, whose value the engine does not " +
    "yet track across assignments",
  conditioned:
    "the argument passed for it is itself non-throwing only given conditions " +
    "of its own, which no argument at this call site can discharge",
  "missing-argument":
    "no argument is passed for it, so there is nothing here to discharge it",
  "beyond-depth":
    "carrying it up to this function would make a path deeper than the engine " +
    "follows",
};

/** The site, as the reader wrote it. */
const describeSite: Record<TransferSite, (text: string) => string> = {
  read: (text) => `Reading \`${text}\``,
  write: (text) => `Writing \`${text}\``,
  update: (text) => `Updating \`${text}\``,
  destructure: (text) => `Destructuring \`${text}\``,
  spread: (text) => `Spreading \`${text}\``,
  coercion: (text) => `Coercing \`${text}\` to a primitive`,
  "instance-check": (text) => `Checking \`${text}\``,
};

function describeTarget(target: Target): string {
  return `the ${target.kind} \`${target.name}\``;
}

type Report =
  | { readonly messageId: "uncaughtThrow" }
  | {
      readonly messageId: "unbridgedCall";
      readonly data: { readonly callee: string; readonly reason: string };
    }
  | {
      readonly messageId: "inferredThrowingCall";
      readonly data: { readonly callee: string };
    }
  | {
      readonly messageId: "conditionArgumentThrowing";
      readonly data: {
        readonly callee: string;
        readonly path: string;
        readonly entry: string;
      };
    }
  | {
      readonly messageId: "conditionArgumentFloored";
      readonly data: {
        readonly callee: string;
        readonly path: string;
        readonly entry: string;
        readonly reason: string;
      };
    }
  | {
      readonly messageId: "unbridgedHiddenTransfer";
      readonly data: { readonly site: string; readonly reason: string };
    }
  | {
      readonly messageId: "inferredThrowingHiddenTransfer";
      readonly data: { readonly site: string; readonly target: string };
    };

/**
 * The whole invariant is one rule, so every escape the core reports has to land
 * on a message inside it. A finding kind with no `case` here stops returning a
 * `Report` on every path, which is a compile error.
 */
function reportFor(finding: Finding, cwd: string): Report {
  switch (finding.kind) {
    case "uncaught-throw":
      return { messageId: "uncaughtThrow" };
    case "unbridged-call":
      return {
        messageId: "unbridgedCall",
        data: { callee: finding.callee, reason: whyFloored[finding.reason] },
      };
    case "inferred-throwing-call":
      return {
        messageId: "inferredThrowingCall",
        data: { callee: finding.callee },
      };
    case "throwing-condition-argument":
      return {
        messageId: "conditionArgumentThrowing",
        data: {
          callee: finding.callee,
          path: finding.path,
          entry: entryText(finding.entry, cwd),
        },
      };
    case "floored-condition-argument":
      return {
        messageId: "conditionArgumentFloored",
        data: {
          callee: finding.callee,
          path: finding.path,
          entry: entryText(finding.entry, cwd),
          reason: whyUndischarged[finding.reason],
        },
      };
    case "unbridged-hidden-transfer":
      return {
        messageId: "unbridgedHiddenTransfer",
        data: {
          site: describeSite[finding.site](finding.text),
          reason:
            finding.target === undefined
              ? `the checker cannot resolve \`${finding.text}\` to a ` +
                "declaration, so nothing can say whether a body runs here"
              : `it runs ${describeTarget(finding.target)}, which ${whyFloored[finding.reason]}`,
        },
      };
    case "inferred-throwing-hidden-transfer":
      return {
        messageId: "inferredThrowingHiddenTransfer",
        data: {
          site: describeSite[finding.site](finding.text),
          target: describeTarget(finding.target),
        },
      };
  }
}

/**
 * Where the callee's body enters the path, as a place a reader can open. The
 * core reports an absolute file name because it has no notion of a project
 * root; the adapter has one, and printing paths is not analysis.
 */
function entryText(entry: EntrySite, cwd: string): string {
  const path = relative(cwd, entry.fileName).split(sep).join("/");
  return `${path}:${entry.line}`;
}

export const noEscapingThrow = createRule<[], MessageId>({
  name: "no-escaping-throw",
  meta: {
    type: "problem",
    docs: {
      description: "Enforce that no throw escapes a function marked `@nothrow`.",
    },
    messages,
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      // The whole file goes to the core in one piece: deciding which nodes are
      // candidate marks is analysis, and the adapter does none.
      Program(node: TSESTree.Program): void {
        const sourceFile = services.esTreeNodeToTSNodeMap.get(
          node,
        ) as ts.SourceFile;

        for (const finding of analyzeSourceFile(sourceFile, checker)) {
          const reportAt = services.tsNodeToESTreeNodeMap.get(finding.node);
          context.report({
            node: reportAt ?? node,
            ...reportFor(finding, context.cwd),
          });
        }
      },
    };
  },
});

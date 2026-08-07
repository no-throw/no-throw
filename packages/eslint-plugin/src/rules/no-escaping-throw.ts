import {
  analyzeSourceFile,
  type ConsumptionReason,
  type Finding,
  type FloorReason,
} from "@nothrow/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type ts from "typescript";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/MidnightDesign/no-throw#${name}`,
);

/**
 * The outs a floor must name, in precedence order. They live in the message
 * text and never behind a docs URL: the CI log is the channel that survives
 * into code review, and acting on a floor from it alone is the whole contract.
 */
const outs = (what: string): string =>
  `Your outs, in precedence order: bridge this ${what} with \`try\`/\`catch\`; ` +
  "assert the color in `nothrow.overrides.json`; install or write an " +
  "`@nothrow/*` overlay; or, if you own the package, ship a manifest with " +
  "`nothrow emit`.";

/**
 * A returned iterator is consumed by the caller, so the bridge is not on this
 * side of the boundary. What is: naming the call that produced it.
 */
const RETURN_OUTS =
  "Your outs, in precedence order: return the iterator from a call this rule " +
  "can trace — a direct call, or a `const` initialized by one; assert the " +
  "producer's color in `nothrow.overrides.json`; install or write an " +
  "`@nothrow/*` overlay; or, if you own the package, ship a manifest with " +
  "`nothrow emit`.";

const messages = {
  uncaughtThrow: "Uncaught `throw` escapes this `@nothrow` function.",
  unbridgedCall:
    "Call to `{{callee}}` escapes this `@nothrow` function: {{reason}}. " +
    outs("call"),
  // Not a floor, so not the floor's outs: the body was read and it can throw,
  // and every carrier on that list would be silencing a true positive.
  inferredThrowingCall:
    "Call to `{{callee}}` escapes this `@nothrow` function: its body was " +
    "analyzed and can throw. Your outs: bridge this call with `try`/`catch`, " +
    "or make `{{callee}}` non-throwing — mark it `@nothrow` and the escapes " +
    "inside it are reported too.",
  unbridgedConsumption:
    "Consuming this iterator escapes this `@nothrow` function: {{reason}}. " +
    outs("consumption"),
  inferredThrowingConsumption:
    "Consuming this iterator escapes this `@nothrow` function: the body " +
    "producing its values was analyzed and can throw. Your outs: bridge this " +
    "consumption with `try`/`catch`, or make that producer non-throwing — " +
    "mark it `@nothrow` and the escapes inside it are reported too.",
  // No carrier can color this away, and no body can either: the value being
  // thrown is written right here.
  iteratorThrow:
    "`.throw()` escapes this `@nothrow` function: it throws the value into " +
    "the iterator, whatever the iterator makes of it — a throw cannot be " +
    "laundered through one. Bridge it with `try`/`catch`.",
  unprovableReturnedIterator:
    "This `@nothrow` function returns an iterator, so the mark covers " +
    "consuming it too: {{reason}}. " +
    RETURN_OUTS,
  inferredThrowingReturnedIterator:
    "This `@nothrow` function returns an iterator, so the mark covers " +
    "consuming it too: the body producing its values was analyzed and can " +
    "throw. Your outs: return an iterator from a non-throwing producer, or " +
    "make that producer non-throwing — mark it `@nothrow` and the escapes " +
    "inside it are reported too.",
} as const;

type MessageId = keyof typeof messages;

/** The why half of the two-clause floor contract. */
const whyFloored: Record<FloorReason, string> = {
  bodyless:
    "it is declared without a body — an ambient or `.d.ts` declaration — " +
    "and no mark, manifest, overlay or override colors it, so it is " +
    "assumed to throw",
  unmarked:
    "it has a visible body but no `@nothrow` mark, so it is throwing by " +
    "declaration",
  unresolvable:
    "the checker cannot resolve it to a declaration, so nothing can say " +
    "whether it throws",
};

/**
 * The why half of the floor contract for a consumption site. The subject is
 * the iterator rather than a named callee: what runs when you consume one is
 * the protocol, and the author wrote none of it.
 */
const whyConsumptionFloored: Record<
  Exclude<ConsumptionReason, "inferred">,
  string
> = {
  bodyless:
    "what consuming it runs is declared without a body — an ambient or " +
    "`.d.ts` declaration, the standard library's iteration protocol among " +
    "them — and no mark, manifest, overlay or override colors it, so it is " +
    "assumed to throw",
  unmarked:
    "what consuming it runs has a visible body but no `@nothrow` mark, so it " +
    "is throwing by declaration",
  unresolvable:
    "the checker cannot resolve what consuming it runs, so nothing can say " +
    "whether it throws",
  "untraced-binding":
    "it reaches here through a binding this rule does not follow yet — only " +
    "a direct call, or a `const` initialized by one, traces to the call that " +
    "produced it — so it is assumed to throw",
  "untraced-opaque":
    "nothing in the syntax names the call that produced it, so nothing can " +
    "say whether consuming it throws",
};

type Report =
  | { readonly messageId: "uncaughtThrow" | "iteratorThrow" }
  | {
      readonly messageId: "unbridgedCall";
      readonly data: { readonly callee: string; readonly reason: string };
    }
  | {
      readonly messageId: "inferredThrowingCall";
      readonly data: { readonly callee: string };
    }
  | {
      readonly messageId:
        | "unbridgedConsumption"
        | "unprovableReturnedIterator";
      readonly data: { readonly reason: string };
    }
  | {
      readonly messageId:
        | "inferredThrowingConsumption"
        | "inferredThrowingReturnedIterator";
    };

/**
 * The whole invariant is one rule, so every escape the core reports has to land
 * on a message inside it. A finding kind with no `case` here stops returning a
 * `Report` on every path, which is a compile error.
 */
function reportFor(finding: Finding): Report {
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
    case "iterator-throw":
      return { messageId: "iteratorThrow" };
    case "throwing-consumption":
      return finding.reason === "inferred"
        ? { messageId: "inferredThrowingConsumption" }
        : {
            messageId: "unbridgedConsumption",
            data: { reason: whyConsumptionFloored[finding.reason] },
          };
    case "throwing-returned-iterator":
      return finding.reason === "inferred"
        ? { messageId: "inferredThrowingReturnedIterator" }
        : {
            messageId: "unprovableReturnedIterator",
            data: { reason: whyConsumptionFloored[finding.reason] },
          };
  }
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
          context.report({ node: reportAt ?? node, ...reportFor(finding) });
        }
      },
    };
  },
});

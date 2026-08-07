import {
  analyzeSourceFile,
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
const OUTS =
  "Your outs, in precedence order: bridge this call with `try`/`catch`; " +
  "assert the color in `nothrow.overrides.json`; install or write an " +
  "`@nothrow/*` overlay; or, if you own the package, ship a manifest with " +
  "`nothrow emit`.";

const messages = {
  uncaughtThrow: "Uncaught `throw` escapes this `@nothrow` function.",
  unbridgedCall:
    "Call to `{{callee}}` escapes this `@nothrow` function: {{reason}}. " +
    OUTS,
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

type Report =
  | { readonly messageId: "uncaughtThrow" }
  | {
      readonly messageId: "unbridgedCall";
      readonly data: { readonly callee: string; readonly reason: string };
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

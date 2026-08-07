import { analyzeSourceFile, type FindingKind } from "@nothrow/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type ts from "typescript";
import { locOf } from "../loc.js";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/MidnightDesign/no-throw#${name}`,
);

const messages = {
  uncaughtThrow: "Uncaught `throw` escapes this `@nothrow` function.",
} as const;

type MessageId = keyof typeof messages;

/**
 * The whole invariant is one rule, so every escape kind the core reports has to
 * land on a message inside it. An unmapped kind is a compile error here.
 */
const messageIdByKind: Record<FindingKind, MessageId> = {
  "uncaught-throw": "uncaughtThrow",
};

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

    return {
      // The whole file goes to the core in one piece: deciding which nodes are
      // candidate marks is analysis, and the adapter does none.
      Program(node: TSESTree.Program): void {
        const sourceFile = services.esTreeNodeToTSNodeMap.get(
          node,
        ) as ts.SourceFile;

        for (const finding of analyzeSourceFile(sourceFile)) {
          context.report({
            loc: locOf(sourceFile, finding.span),
            messageId: messageIdByKind[finding.kind],
          });
        }
      },
    };
  },
});

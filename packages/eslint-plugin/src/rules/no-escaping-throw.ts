import { analyzeFunction, type FindingKind } from "@nothrow/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

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

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

export const noEscapingThrow = createRule<[], MessageId>({
  name: "no-escaping-throw",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce that no throw escapes a function marked `@nothrow`.",
    },
    messages,
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const host = { checker: services.program.getTypeChecker() };

    const check = (node: FunctionNode): void => {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);

      for (const finding of analyzeFunction(tsNode, host)) {
        const reportAt = services.tsNodeToESTreeNodeMap.get(finding.node);
        context.report({
          node: reportAt ?? node,
          messageId: messageIdByKind[finding.kind],
        });
      }
    };

    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    };
  },
});

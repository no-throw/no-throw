import {
  markMessages,
  markReports,
  type MarkMessageId,
} from "@no-throw/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type ts from "typescript";
import { locOf } from "../loc.js";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/no-throw/no-throw#${name}`,
);

export const validMark = createRule<[], MarkMessageId>({
  name: "valid-mark",
  meta: {
    type: "problem",
    docs: {
      description: "Require every `@nothrow` tag to bind to a function.",
    },
    messages: markMessages,
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);

    return {
      Program(node: TSESTree.Program): void {
        const sourceFile = services.esTreeNodeToTSNodeMap.get(
          node,
        ) as ts.SourceFile;

        for (const report of markReports(sourceFile)) {
          context.report({
            loc: locOf(sourceFile, report.anchor),
            messageId: report.messageId,
            data: report.data,
          });
        }
      },
    };
  },
});

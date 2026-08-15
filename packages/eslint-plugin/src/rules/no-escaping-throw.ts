import {
  escapeMessages,
  escapeReports,
  type EscapeMessageId,
  type EscapeOffer,
} from "@no-throw/core";
import {
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import type ts from "typescript";
import { locOf } from "../loc.js";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/no-throw/no-throw#${name}`,
);

/**
 * The offer, where the engine made one. It is never a `fix`: wrapping a call
 * in a bridge changes what the program does with an error, and a tool may not
 * make that choice on the reader's behalf — `--fix` would rewrite a whole
 * codebase into one that swallows everything and reports nothing.
 */
function suggestionFor(
  offer: EscapeOffer | undefined,
): TSESLint.ReportSuggestionArray<EscapeMessageId> | undefined {
  if (offer === undefined) return undefined;
  const { range, text } = offer.edit;
  return [
    {
      messageId: offer.messageId,
      fix: (fixer) => fixer.replaceTextRange([range[0], range[1]], text),
    },
  ];
}

export const noEscapingThrow = createRule<[], EscapeMessageId>({
  name: "no-escaping-throw",
  meta: {
    type: "problem",
    docs: {
      description: "Enforce that no throw escapes a function marked `@nothrow`.",
    },
    hasSuggestions: true,
    messages: escapeMessages,
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

        for (const report of escapeReports(
          sourceFile,
          services.program,
          context.cwd,
        )) {
          const suggest = suggestionFor(report.offer);
          context.report({
            loc: locOf(sourceFile, report.anchor),
            messageId: report.messageId,
            ...(report.data === undefined ? {} : { data: report.data }),
            ...(suggest === undefined ? {} : { suggest }),
          });
        }
      },
    };
  },
});

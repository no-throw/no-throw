import {
  locationOf,
  markMessages,
  markReports,
  mayHoldMark,
} from "@no-throw/core";
import ts from "typescript";
import type { HostContext, HostRule } from "../host.js";
import { isTypeScriptFile } from "../scope.js";

export const validMark: HostRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require every `@nothrow` tag to bind to a function.",
    },
    messages: markMessages,
  },
  create(context: HostContext) {
    if (!isTypeScriptFile(context.filename)) return {};

    return {
      Program(): void {
        const text = context.sourceCode.text;
        // Every problem this rule reports is a mark that failed to bind, so a
        // file whose text holds nothing mark-shaped has none — and is not
        // parsed to find that out.
        if (!mayHoldMark(text)) return;

        // Mark hygiene is syntactic, so this rule owes nobody a program: it
        // parses the text the host handed over and reads the marks off that.
        // A file no project includes still gets its dead marks reported.
        const sourceFile = ts.createSourceFile(
          context.filename,
          text,
          ts.ScriptTarget.Latest,
          true,
        );

        for (const found of markReports(sourceFile)) {
          context.report({
            loc: locationOf(sourceFile, found.anchor),
            messageId: found.messageId,
            data: found.data,
          });
        }
      },
    };
  },
};

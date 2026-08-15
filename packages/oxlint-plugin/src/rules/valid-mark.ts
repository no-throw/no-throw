import { markMessages, markReports } from "@no-throw/core";
import ts from "typescript";
import type { HostContext, HostRule } from "../host.js";
import { locOf } from "../loc.js";
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
        // Mark hygiene is syntactic, so this rule owes nobody a program: it
        // parses the text the host handed over and reads the marks off that.
        // A file no project includes still gets its dead marks reported.
        const sourceFile = ts.createSourceFile(
          context.filename,
          context.sourceCode.text,
          ts.ScriptTarget.Latest,
          true,
        );

        for (const found of markReports(sourceFile)) {
          context.report({
            loc: locOf(sourceFile, found.anchor),
            messageId: found.messageId,
            data: found.data,
          });
        }
      },
    };
  },
};

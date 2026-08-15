import {
  escapeMessages,
  escapeReports,
  locationOf,
  type EscapeOffer,
} from "@no-throw/core";
import type ts from "typescript";
import type { HostContext, HostRule, HostSuggestion } from "../host.js";
import { projectFor } from "../project.js";
import { isTypeScriptFile } from "../scope.js";

/**
 * The rules are type-aware and oxlint hands a plugin no types, so the program
 * is this adapter's to find — and a file it cannot find one for gets a
 * diagnostic naming the config to fix, not a silent pass. Silence there would
 * be a hole in the invariant shaped exactly like a misconfigured project; on
 * the ESLint side the same files are the parse errors `projectService` raises,
 * so neither host lets one slip through green.
 */
const hosting = {
  noProject:
    "No `tsconfig.json` sits above this file, so there is no program to read " +
    "its types from, and every color is read off the types — nothing here was " +
    "analyzed. Move the file under a project.",
  outsideProject:
    "`{{config}}` does not include this file, so the program it describes " +
    "cannot see it, and nothing here was analyzed. Include the file in that " +
    "`tsconfig.json`.",
  brokenProject:
    "`{{config}}` could not be read as a project, so nothing here was " +
    "analyzed: {{message}}",
} as const;

/** Where a whole-file report lands: the first thing in the file. */
const FILE_START = {
  start: { line: 1, column: 0 },
  end: { line: 1, column: 1 },
} as const;

/**
 * The offer, where the engine made one. It rides the suggestion channel and
 * never the fix one: wrapping a call in a bridge changes what the program does
 * with an error, so `oxlint --fix` must never make that choice for the reader.
 */
function suggestionFor(
  offer: EscapeOffer | undefined,
): readonly HostSuggestion[] | undefined {
  if (offer === undefined) return undefined;
  const { range, text } = offer.edit;
  return [
    {
      messageId: offer.messageId,
      fix: (fixer) => fixer.replaceTextRange([range[0], range[1]], text),
    },
  ];
}

export const noEscapingThrow: HostRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce that no throw escapes a function marked `@nothrow`.",
    },
    hasSuggestions: true,
    messages: { ...escapeMessages, ...hosting },
  },
  create(context: HostContext) {
    if (!isTypeScriptFile(context.filename)) return {};

    return {
      Program(): void {
        const text = context.sourceCode.text;
        const answer = projectFor(context.filename, text);

        if (answer.kind !== "program") {
          context.report({
            loc: FILE_START,
            messageId: hostingMessageId[answer.kind],
            data:
              answer.kind === "no-project"
                ? {}
                : answer.kind === "outside-project"
                  ? { config: answer.configPath }
                  : { config: answer.configPath, message: answer.message },
          });
          return;
        }

        report(context, answer.sourceFile, answer.program);
      },
    };
  },
};

const hostingMessageId = {
  "no-project": "noProject",
  "outside-project": "outsideProject",
  "broken-project": "brokenProject",
} as const;

function report(
  context: HostContext,
  sourceFile: ts.SourceFile,
  program: ts.Program,
): void {
  // The whole file goes to the core in one piece: deciding which nodes are
  // escape sites is analysis, and the adapter does none.
  for (const found of escapeReports(sourceFile, program, context.cwd)) {
    const suggest = suggestionFor(found.offer);
    context.report({
      loc: locationOf(sourceFile, found.anchor),
      messageId: found.messageId,
      ...(found.data === undefined ? {} : { data: found.data }),
      ...(suggest === undefined ? {} : { suggest }),
    });
  }
}

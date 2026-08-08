import { findMarks, type MarkProblemKind } from "@no-throw/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type ts from "typescript";
import { locOf } from "../loc.js";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/MidnightDesign/no-throw#${name}`,
);

const WHITELIST =
  "A mark binds on a function declaration, a single-declarator variable statement with a function or arrow initializer, a class method or constructor, an accessor, or an object-literal method or function-valued property.";

const messages = {
  nonJsdocMark:
    "`@{{tag}}` in a {{form}} comment is not a mark: a mark is read only from a JSDoc block comment, so this one enforces nothing. Write it as `/** @nothrow */`.",
  misspelledMark:
    "`@{{tag}}` is not a mark: the mark is spelled `@nothrow`, and this differs from it only in case and separators, so it is read as an unrelated tag and enforces nothing. Spell it `@nothrow`.",
  ineffectiveMark: `\`@nothrow\` binds to nothing here. The nearest valid site is {{site}} on line {{line}}. ${WHITELIST}`,
  ineffectiveMarkNoSite: `\`@nothrow\` binds to nothing here, and there is no valid site near it to move it to. ${WHITELIST}`,
  multiDeclarator:
    "`@nothrow` binds to nothing on a variable statement declaring more than one variable: which one it marks would be a guess. Give the marked function a declaration of its own.",
  ambientDeclaration:
    "`@nothrow` binds to nothing on an ambient declaration: there is no body to verify it against, and an in-source mark is always verified. Assert the color in `nothrow.overrides.json` instead.",
  interfaceMember:
    "`@nothrow` binds to nothing on an interface member: there is no body to verify it against, and an implementation cannot be held to it. Mark the implementing function instead.",
  abstractMethod:
    "`@nothrow` binds to nothing on an abstract method: there is no body to verify it against. Mark the implementing method in each subclass instead.",
  overloadSignature:
    "`@nothrow` binds to nothing on an overload signature: there is no body to verify it against. Move it to the implementation signature, the one declaration with a body.",
} as const;

type MessageId = keyof typeof messages;

/** An unmapped problem kind is a compile error here, never a dropped report. */
const messageIdByKind: Record<MarkProblemKind, MessageId> = {
  "non-jsdoc-mark": "nonJsdocMark",
  "misspelled-mark": "misspelledMark",
  "ineffective-mark": "ineffectiveMark",
  "ineffective-mark-no-site": "ineffectiveMarkNoSite",
  "multi-declarator": "multiDeclarator",
  "ambient-declaration": "ambientDeclaration",
  "interface-member": "interfaceMember",
  "abstract-method": "abstractMethod",
  "overload-signature": "overloadSignature",
};

export const validMark = createRule<[], MessageId>({
  name: "valid-mark",
  meta: {
    type: "problem",
    docs: {
      description: "Require every `@nothrow` tag to bind to a function.",
    },
    messages,
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

        for (const problem of findMarks(sourceFile).problems) {
          context.report({
            loc: locOf(sourceFile, problem.span),
            messageId: messageIdByKind[problem.kind],
            data: problem.data,
          });
        }
      },
    };
  },
});

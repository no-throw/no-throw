import nothrow from "@nothrow/eslint-plugin";
import { ESLint, type Linter } from "eslint";
import { relative, sep } from "node:path";
import tseslint from "typescript-eslint";
import type { Diagnostic } from "./diagnostics.js";

/**
 * The v1 driver: run a fixture project through the real plugin, over the real
 * typescript-eslint parser, and hand back the diagnostics it produced. It knows
 * nothing about the engine — only what a consumer's ESLint would see.
 */
export async function runFixture(
  directory: string,
): Promise<readonly Diagnostic[]> {
  const config: Linter.Config[] = [
    {
      files: ["**/*.ts"],
      languageOptions: {
        parser: tseslint.parser as Linter.Parser,
        parserOptions: {
          project: "./tsconfig.json",
          tsconfigRootDir: directory,
        },
      },
      // typescript-eslint's `RuleModule` and ESLint's core `RuleDefinition`
      // describe the same object through incompatible context types, and
      // neither package widens for the other.
      plugins: { nothrow: nothrow as unknown as ESLint.Plugin },
      rules: { "nothrow/no-escaping-throw": "error" },
    },
  ];

  const eslint = new ESLint({
    cwd: directory,
    overrideConfigFile: true,
    overrideConfig: config,
  });

  const results = await eslint.lintFiles(["src/**/*.ts"]);
  const diagnostics: Diagnostic[] = [];

  for (const result of results) {
    const file = toFixturePath(directory, result.filePath);

    for (const message of result.messages) {
      if (message.fatal === true || message.ruleId === null) {
        throw new Error(
          `${file}:${message.line}:${message.column}: ESLint failed before the rule ran — ${message.message}`,
        );
      }
      if (message.messageId === undefined) {
        throw new Error(
          `${file}:${message.line}:${message.column}: \`${message.ruleId}\` reported without a messageId`,
        );
      }

      diagnostics.push({
        file,
        line: message.line,
        column: message.column,
        endLine: message.endLine ?? message.line,
        endColumn: message.endColumn ?? message.column,
        messageId: message.messageId,
        message: message.message,
      });
    }
  }

  return diagnostics;
}

function toFixturePath(directory: string, filePath: string): string {
  return relative(directory, filePath).split(sep).join("/");
}

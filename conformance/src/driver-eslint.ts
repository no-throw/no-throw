import nothrow from "@nothrow/eslint-plugin";
import { ESLint, type Linter } from "eslint";
import { relative, sep } from "node:path";
import tseslint from "typescript-eslint";
import type { Diagnostic } from "./diagnostics.js";
import type { FixtureConfig } from "./fixtures.js";

/**
 * The v1 driver: run a fixture project through the real plugin, over the real
 * typescript-eslint parser, and hand back the diagnostics it produced. It knows
 * nothing about the engine — only what a consumer's ESLint would see.
 */
export async function runFixture(
  directory: string,
  fixtureConfig: FixtureConfig,
): Promise<readonly Diagnostic[]> {
  const language: Linter.Config = {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser as Linter.Parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: directory,
      },
    },
  };

  // typescript-eslint's `RuleModule` and ESLint's core `RuleDefinition`
  // describe the same object through incompatible context types, and neither
  // package widens for the other.
  const rules: Linter.Config = {
    files: ["**/*.ts"],
    plugins: { nothrow: nothrow as unknown as ESLint.Plugin },
    rules: {
      "nothrow/no-escaping-throw": "error",
      "nothrow/valid-mark": "error",
    },
  };

  // The preset is what a user installs, so it is asserted as shipped: the
  // fixture adds a file filter and nothing else.
  const preset: Linter.Config = {
    files: ["**/*.ts"],
    ...(nothrow.configs.recommended as unknown as Linter.Config),
  };

  const config: Linter.Config[] = [
    language,
    fixtureConfig === "recommended" ? preset : rules,
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
      // Wrapping a call in a bridge changes behavior, so the edit is always the
      // reader's to accept: an autofix is a spec violation, not a fixture one.
      // This guard stays whole-config on purpose — `--fix` applies every rule
      // the preset turns on, so a third party's fixer would edit under our name.
      if (message.fix !== undefined) {
        throw new Error(
          `${file}:${message.line}:${message.column}: \`${message.ruleId}\` offered an autofix; no rule may`,
        );
      }
      // Our rules will offer suggestions once there is a bridge edit to
      // suggest, and nothing in `expected.json` can express one yet: fail
      // loudly rather than drop them from the seam silently. Rules the preset
      // merely turns on are somebody else's surface, and pinning a
      // dependency's suggestion text here would assert nothing about us.
      if (message.suggestions !== undefined && isOurs(message.ruleId)) {
        throw new Error(
          `${file}:${message.line}:${message.column}: \`${message.ruleId}\` offered suggestions, which the expectation format cannot yet assert`,
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

function isOurs(ruleId: string): boolean {
  return ruleId.startsWith("nothrow/");
}

function toFixturePath(directory: string, filePath: string): string {
  return relative(directory, filePath).split(sep).join("/");
}

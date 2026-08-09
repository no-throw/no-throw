import nothrow from "@no-throw/eslint-plugin";
import { createProgram } from "@typescript-eslint/typescript-estree";
import { ESLint, type Linter } from "eslint";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import tseslint from "typescript-eslint";
import type { Diagnostic, Suggestion } from "./diagnostics.js";
import type { FixtureConfig } from "./fixtures.js";

/**
 * Every TypeScript extension the preset claims. The harness has to reach at
 * least as far as the thing it installs, or a fixture file the preset visits
 * would arrive at a type-aware rule with ESLint's default parser and no
 * program — the harness reproducing the very defect a fixture is there to
 * catch. Written out rather than read off the preset, because a user writes
 * this glob by hand too.
 */
const TYPESCRIPT_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

/**
 * The diagnostics whose remedy is a mechanical bridge, and so the only ones
 * that may offer an edit. Held here rather than read off the plugin because it
 * is the spec's claim about the plugin: anywhere else, an offer is an offer to
 * silence a true report. A messageId this suite has not heard of is not on the
 * list, so a new one that starts offering edits trips this rather than
 * inheriting a permission nobody granted.
 */
const BRIDGEABLE = new Set([
  "unbridgedCall",
  "inferredThrowingCall",
  "conditionArgumentThrowing",
  "conditionArgumentFloored",
  "carriedConditionArgumentThrowing",
  "carriedConditionArgumentFloored",
  "unbridgedConsumption",
  "inferredThrowingConsumption",
  "iteratorThrow",
  "unbridgedAwait",
  "inferredThrowingAwait",
  "unprovableFloat",
  "inferredThrowingFloat",
  "fakeBridge",
  "unbridgedHiddenTransfer",
  "inferredThrowingHiddenTransfer",
]);

/**
 * The v1 driver: run a fixture project through the real plugin, over the real
 * typescript-eslint parser, and hand back the diagnostics it produced. It knows
 * nothing about the engine — only what a consumer's ESLint would see.
 */
export async function runFixture(
  directory: string,
  fixtureConfig: FixtureConfig,
): Promise<readonly Diagnostic[]> {
  // Handing the parser a program the driver built, rather than naming a
  // project for it to find, is what keeps the suite's memory flat: `project`
  // parks a watch program per `tsconfig.json` in module state for the life of
  // the process, and every fixture is its own project the suite never visits
  // twice, so the run pins one whole TypeScript program per fixture and
  // exhausts the heap partway through. This program dies with the call.
  const language: Linter.Config = {
    files: TYPESCRIPT_FILES,
    languageOptions: {
      parser: tseslint.parser as Linter.Parser,
      parserOptions: {
        programs: [createProgram("./tsconfig.json", directory)],
        tsconfigRootDir: directory,
      },
    },
  };

  // typescript-eslint's `RuleModule` and ESLint's core `RuleDefinition`
  // describe the same object through incompatible context types, and neither
  // package widens for the other.
  const rules: Linter.Config = {
    files: TYPESCRIPT_FILES,
    plugins: { nothrow: nothrow as unknown as ESLint.Plugin },
    rules: {
      "nothrow/no-escaping-throw": "error",
      "nothrow/valid-mark": "error",
    },
  };

  // The preset is what a user installs, so it goes in untouched — which files
  // it reaches is one of the things a fixture gets to assert. It is handed the
  // same typescript-eslint plugin object this driver's parser comes from,
  // which is exactly what a consumer does.
  const preset = nothrow.configs.recommended(
    tseslint.plugin,
  ) as unknown as Linter.Config;

  // What every project with typed lint in CI already has, and so the shape the
  // preset has to survive being dropped next to: flat config refuses a plugin
  // name registered twice with two different objects, so the preset taking the
  // consumer's own object is the whole reason this loads at all.
  const existing: Linter.Config = {
    files: TYPESCRIPT_FILES,
    plugins: { "@typescript-eslint": tseslint.plugin as ESLint.Plugin },
  };

  const config: Linter.Config[] =
    fixtureConfig === "recommended"
      ? [language, preset]
      : fixtureConfig === "recommended-beside-typescript-eslint"
        ? [language, existing, preset]
        : [language, rules];

  const eslint = new ESLint({
    cwd: directory,
    overrideConfigFile: true,
    overrideConfig: config,
  });

  // `eslint .` is what a user runs, and it is the invocation that finds a
  // config reaching files it cannot analyze: naming the TypeScript sources here
  // would scope that class of defect out of the suite entirely.
  const results = await eslint.lintFiles(["."]);
  const diagnostics: Diagnostic[] = [];

  for (const result of results) {
    const file = toFixturePath(directory, result.filePath);
    const source = readFileSync(result.filePath, "utf8");

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
      // Rules the preset merely turns on are somebody else's surface, and
      // pinning a dependency's suggestion text here would assert nothing about
      // us — so only ours are carried, and only ours are held to the list.
      const suggestions = isOurs(message.ruleId)
        ? (message.suggestions ?? [])
        : [];
      if (suggestions.length > 0 && !BRIDGEABLE.has(message.messageId)) {
        throw new Error(
          `${file}:${message.line}:${message.column}: \`${message.messageId}\` offered an edit, and its remedy is not a mechanical bridge`,
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
        suggestions: suggestions.map((suggestion) =>
          toSuggestion(suggestion, source),
        ),
      });
    }
  }

  return diagnostics;
}

/**
 * The preset registers the plugin object it is handed, which is what keeps
 * ESLint's identity check from ever seeing two `@typescript-eslint`s. That only
 * pays if a wrong argument is refused at the site the reader typed, since the
 * alternative is the startup crash the shape exists to remove — and it must be
 * refused loudly, because a preset that quietly degraded to "name the rule,
 * register nothing" would mean two different things by arity.
 *
 * It lives beside the driver rather than in a fixture for the reason the driver
 * itself exists: what is asserted is a config a reader writes by hand, in the
 * linter this driver knows about, and it exists before any project is on disk.
 */
export function presetArgumentReport(): {
  readonly checked: number;
  readonly problems: readonly string[];
} {
  const refused = [
    ["no argument", undefined],
    ["the `typescript-eslint` umbrella", tseslint],
    ["a plugin without the float rule", { rules: {} }],
    ["a non-object", 42],
  ] as const;

  const problems: string[] = [];

  for (const [what, argument] of refused) {
    // Wrong on purpose: the point is what happens when a reader is.
    const refusal = refusalMessage(argument);
    if (refusal === undefined) {
      problems.push(`the preset accepted ${what}`);
    } else if (!refusal.includes("tseslint.plugin")) {
      problems.push(
        `the preset refused ${what} without naming \`tseslint.plugin\`: ${refusal}`,
      );
    }
  }

  const accepted = refusalMessage(tseslint.plugin);
  if (accepted !== undefined) {
    problems.push(
      `the preset refused typescript-eslint's own plugin object: ${accepted}`,
    );
  }

  return { checked: refused.length, problems };
}

/** What the preset said about this argument, or nothing if it took it. */
function refusalMessage(argument: unknown): string | undefined {
  try {
    (nothrow.configs.recommended as (value: unknown) => unknown)(argument);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * What accepting the edit leaves on disk. Line endings are a checkout artifact
 * — the fixtures are LF, a Windows clone may not be — so they are normalized
 * away rather than asserted.
 */
function toSuggestion(
  suggestion: Linter.LintSuggestion,
  source: string,
): Suggestion {
  const [start, end] = suggestion.fix.range;
  const output =
    source.slice(0, start) + suggestion.fix.text + source.slice(end);
  return { desc: suggestion.desc, output: output.split(/\r?\n/) };
}

function isOurs(ruleId: string): boolean {
  return ruleId.startsWith("nothrow/");
}

function toFixturePath(directory: string, filePath: string): string {
  return relative(directory, filePath).split(sep).join("/");
}

import { hostModule } from "../host.js";
import { RESULT_MARKER, type LintResult } from "../lint.js";

/**
 * One cold lint, in its own process. Cold is the shape CI has: nothing is
 * warm, the program is built from scratch, and the process dies afterwards —
 * which is also what makes the arms independent of each other's heap.
 *
 * Rule times come from ESLint's own `TIMING`, so the parent gets our rule's
 * share of the run without the harness instrumenting anything.
 */
async function main(): Promise<void> {
  const [targetDirectory, configFile, paths, ignore] = process.argv.slice(2);
  if (
    targetDirectory === undefined ||
    configFile === undefined ||
    paths === undefined ||
    ignore === undefined
  ) {
    throw new Error(
      "usage: lint-once <target-directory> <config-file> <paths> <ignore-patterns>",
    );
  }

  const { ESLint } = await hostModule<typeof import("eslint")>(
    targetDirectory,
    "eslint",
  );

  const eslint = new ESLint({
    cwd: targetDirectory,
    overrideConfigFile: configFile,
    ignorePatterns: split(ignore),
  });

  const started = performance.now();
  const results = await eslint.lintFiles(split(paths));
  const wallMs = performance.now() - started;

  const result: LintResult = {
    wallMs,
    files: results.length,
    errors: results.reduce((total, one) => total + one.errorCount, 0),
    warnings: results.reduce((total, one) => total + one.warningCount, 0),
    counts: countByRule(results),
  };

  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
}

function split(list: string): string[] {
  return list === "" ? [] : list.split(",");
}

function countByRule(
  results: readonly { messages: readonly { ruleId: string | null }[] }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    for (const message of result.messages) {
      const key = message.ruleId ?? "<fatal>";
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

await main();

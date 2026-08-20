import { spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

/**
 * The oxlint arm. It exists because the ESLint gate's number does not transfer
 * (#156): under ESLint the rules ride a program typescript-eslint already
 * built, and under oxlint there is nothing to ride on, so the adapter builds
 * one itself. That difference is a *fixed* cost — a TypeScript load and a
 * program per `tsconfig.json` — and a fixed cost is invisible in a figure
 * quoted as a percentage of a large run. What this arm measures is the shape
 * the ESLint harness cannot: what the plugin costs a project before it has
 * marked anything, and what it costs once it has.
 *
 * Both arms run the *workspace's* oxlint rather than the target's, because a
 * target need not have one. What that costs in fidelity it buys back in reach:
 * any project on disk can be a target, which is what a reader who wants to
 * check the published number on their own tree needs.
 */

const require = createRequire(import.meta.url);

/** The binary this workspace resolves, run through this Node. */
const OXLINT_BIN = join(
  require.resolve("oxlint/package.json"),
  "..",
  "bin",
  "oxlint",
);

/**
 * The built plugin, addressed the way a config file in the *target's* tree has
 * to address it: an absolute URL, because nothing over there can resolve a
 * workspace package name.
 */
const PLUGIN = import.meta.resolve("@no-throw/oxlint-plugin");

export type OxlintArm = "baseline" | "plugin";

export interface OxlintRun {
  /** Process wall time, which is what a lint costs: startup, program and all. */
  readonly processMs: number;
  readonly diagnostics: number;
}

/**
 * Each arm as a config file in the target's own root. Everything oxlint would
 * report on its own is off in both, so the delta between them is these two
 * rules and nothing else — which is the number a reader deciding whether to
 * install the plugin is actually asking for.
 */
export function writeOxlintConfigs(
  targetDirectory: string,
): Record<OxlintArm, string> {
  const ignorePatterns = ["**/node_modules/**"];
  const files: Record<OxlintArm, string> = {
    baseline: join(targetDirectory, "dogfood.baseline.oxlint.json"),
    plugin: join(targetDirectory, "dogfood.plugin.oxlint.json"),
  };

  writeFileSync(
    files.baseline,
    `${JSON.stringify({ categories: { correctness: "off" }, ignorePatterns }, undefined, 2)}\n`,
  );
  writeFileSync(
    files.plugin,
    `${JSON.stringify(
      {
        jsPlugins: [PLUGIN],
        categories: { correctness: "off" },
        rules: {
          "nothrow/no-escaping-throw": "error",
          "nothrow/valid-mark": "error",
        },
        ignorePatterns,
      },
      undefined,
      2,
    )}\n`,
  );

  return files;
}

/** One arm, once: a fresh process, a fresh program, nothing warm. */
export async function runOxlint(options: {
  readonly targetDirectory: string;
  readonly configFile: string;
  readonly paths: readonly string[];
}): Promise<OxlintRun> {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [OXLINT_BIN, "-c", options.configFile, "-f", "json", ...options.paths],
    { cwd: options.targetDirectory, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve(status ?? -1));
  });
  const processMs = performance.now() - started;

  // Diagnostics found is a non-zero exit and still a run; no JSON at all is the
  // binary failing, which would leave the arm measuring a crash.
  let parsed;
  try {
    parsed = JSON.parse(stdout) as {
      readonly diagnostics: readonly { readonly message: string }[];
    };
  } catch {
    throw new Error(
      `oxlint exited ${String(code)} without JSON\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`,
    );
  }

  // A plugin that died on every file would otherwise look like a fast arm.
  const died = parsed.diagnostics.filter((diagnostic) =>
    diagnostic.message.startsWith("Error running JS plugin."),
  );
  if (died.length > 0) {
    throw new Error(`a rule died on ${String(died.length)} files: ${died[0]?.message ?? ""}`);
  }

  return { processMs, diagnostics: parsed.diagnostics.length };
}

/**
 * The TypeScript files under the given paths, target-relative and sorted. The
 * arms are handed the paths themselves and oxlint does its own walk, so this is
 * the harness's own view: where seeds go, and the denominator the per-file
 * figure is divided by. Declaration files are left out — they have no bodies,
 * so a mark on one binds to nothing.
 */
export function typeScriptFilesIn(
  targetDirectory: string,
  paths: readonly string[],
): readonly string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
      } else if (/(?<!\.d)\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
        found.push(relative(targetDirectory, path).replace(/\\/g, "/"));
      }
    }
  };

  for (const path of paths) walk(join(targetDirectory, path));
  return [...new Set(found)].sort();
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

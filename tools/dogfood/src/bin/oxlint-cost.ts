import { readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { mayHoldMark } from "@no-throw/core";
import {
  median,
  runOxlint,
  typeScriptFilesIn,
  writeOxlintConfigs,
  type OxlintArm,
} from "../oxlint.js";
import { markFiles, restoreFiles } from "../tree.js";

/**
 * What the oxlint adapter costs a project, at a given number of marks.
 *
 *   oxlint-cost <target> <seed-counts> <repeats> [lintPath...]
 *
 * The arms interleave inside each repeat for the reason the cold ESLint run
 * does: absolute times on a developer machine drift by more than the effect,
 * and arms measured minutes apart measure the drift. A warm-up per seed count
 * is discarded, because marking a tree rewrites it.
 *
 * Every seed count is measured twice over: once linting everything, and once
 * linting a single file. The single-file run is how the *fixed* cost is
 * separated from the per-file one — the plugin loads TypeScript and builds a
 * program whether it is handed one file or a thousand — and the fixed cost is
 * the whole of #156's complaint, since it is what a project pays before it has
 * marked anything at all.
 *
 * The run also reports how many of the linted files hold a mark-shaped token,
 * because that count is what the cost turns on: the adapter reads a file's
 * text before it decides whether to build a program, so files with nothing
 * mark-shaped in them are the ones that cost nothing. The test is deliberately
 * loose — `@nothrow` in a sentence trips it — which makes this repository's own
 * sources a poor target and is exactly why the number is printed rather than
 * assumed.
 */

const [, , targetArgument, countsArgument, repeatsArgument, ...lintPaths] =
  process.argv;

if (targetArgument === undefined) {
  console.error(
    "usage: oxlint-cost <target> <seed-counts> <repeats> [lintPath...]",
  );
  process.exit(2);
}

// `pnpm run` starts the child in the package directory, so a relative target
// is resolved against where the command was typed rather than against here.
const targetDirectory = isAbsolute(targetArgument)
  ? targetArgument
  : resolve(process.env["INIT_CWD"] ?? process.cwd(), targetArgument);
const seedCounts = (countsArgument ?? "0")
  .split(",")
  .map((value) => Number(value.trim()));
const repeats = Number(repeatsArgument ?? "3");
const paths = lintPaths.length > 0 ? lintPaths : ["."];

const files = typeScriptFilesIn(targetDirectory, paths);
if (files.length === 0) {
  console.error(`no TypeScript files under ${paths.join(", ")}`);
  process.exit(2);
}
const configs = writeOxlintConfigs(targetDirectory);

console.log(`target: ${targetDirectory}`);
console.log(`linting: ${paths.join(", ")} — ${String(files.length)} files`);
console.log(`repeats: ${String(repeats)}, interleaved, median reported\n`);

try {
  for (const count of seedCounts) {
    const placed = applySeeds(count);
    const markShaped = markShapedFiles();
    // A run that marked something and cannot find it in the text marked
    // something the adapter will never look at, which would price a load
    // against a program that was never built.
    if (placed > 0 && markShaped.length === 0) {
      throw new Error("marks were placed and none is mark-shaped in the text");
    }
    console.log(
      `## ${String(placed)} marks placed${placed === count ? "" : ` (asked for ${String(count)})`}` +
        `, ${String(markShaped.length)} of ${String(files.length)} files hold a mark-shaped token\n`,
    );

    // The single file has to be one the adapter will look past the text of,
    // or the probe prices the load without the program and the difference
    // gets charged to the files instead. With nothing marked there is no such
    // file and none is wanted: no program is built for any of them either.
    const probeFile = markShaped[0] ?? files[0] ?? ".";
    const whole = await measure(paths);
    const single = await measure([probeFile]);

    report("whole project", whole);
    report(`one file (${probeFile})`, single);

    // Two points on a line: the intercept is what the run pays before it looks
    // at a second file, and the slope is what each further file adds. A slope
    // at or below zero means the two runs did the same work and the fixed cost
    // is the whole of it; printing a negative rate would dress that up as a
    // measurement.
    const marginal =
      (whole.delta - single.delta) / Math.max(files.length - 1, 1);
    console.log(
      marginal > 0
        ? `\n  fixed ${format(single.delta)}, then ${format(marginal)} for each further file\n`
        : `\n  fixed ${format(single.delta)}; the further files cost nothing this run separates\n`,
    );
  }
} finally {
  restoreFiles(targetDirectory, files);
  for (const file of Object.values(configs)) rmSync(file, { force: true });
}

interface Measurement {
  readonly baseline: number;
  readonly plugin: number;
  readonly delta: number;
  readonly diagnostics: number;
}

async function measure(over: readonly string[]): Promise<Measurement> {
  const runs: Record<OxlintArm, number[]> = { baseline: [], plugin: [] };
  let diagnostics = 0;

  // A discarded warm-up per measurement: the first read of a tree that was
  // just rewritten is a disk measurement rather than a lint one.
  for (const arm of ["baseline", "plugin"] as const) {
    await runOxlint({ targetDirectory, configFile: configs[arm], paths: over });
  }

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const arm of ["baseline", "plugin"] as const) {
      const run = await runOxlint({
        targetDirectory,
        configFile: configs[arm],
        paths: over,
      });
      runs[arm].push(run.processMs);
      if (arm === "plugin") diagnostics = run.diagnostics;
    }
  }

  const baseline = median(runs.baseline);
  const plugin = median(runs.plugin);
  return { baseline, plugin, delta: plugin - baseline, diagnostics };
}

function report(what: string, measurement: Measurement): void {
  console.log(
    `  ${what.padEnd(28)} baseline ${format(measurement.baseline).padStart(9)}` +
      `   plugin ${format(measurement.plugin).padStart(9)}` +
      `   delta ${`+${format(measurement.delta)}`.padStart(10)}` +
      `   ${String(measurement.diagnostics)} diagnostics`,
  );
}

function format(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

/**
 * Mark `count` real functions over the files being linted, the same way and
 * with the same check the ESLint gate uses. The count is absolute rather than
 * cumulative, so the tree goes back first.
 */
function applySeeds(count: number): number {
  restoreFiles(targetDirectory, files);
  return count === 0 ? 0 : markFiles(targetDirectory, files, count).length;
}

/**
 * The linted files the adapter will look past the text of. Read from disk each
 * time, because placing seeds changes which ones they are.
 */
function markShapedFiles(): readonly string[] {
  return files.filter((file) =>
    mayHoldMark(readFileSync(join(targetDirectory, file), "utf8")),
  );
}


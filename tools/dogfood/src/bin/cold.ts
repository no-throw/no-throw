import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  writeEslintConfigs,
  type EslintArm,
  type Policy,
} from "../configs.js";
import { hostVersions } from "../host.js";
import { coldLint, type ColdRun } from "../lint.js";
import { targetNamed } from "../targets.js";
import { applySeeds, restoreTree } from "../tree.js";

interface Cell {
  /** Marks actually placed, which is what the arm measured. */
  readonly seeds: number;
  readonly arm: EslintArm;
  readonly policy: Policy;
  readonly runs: readonly ColdRun[];
}

/** Every arm to run, and under which policy, in the order a repeat runs them. */
function armsOf(arms: readonly EslintArm[]): { arm: EslintArm; policy: Policy }[] {
  return arms.flatMap((arm): { arm: EslintArm; policy: Policy }[] =>
    arm === "baseline"
      ? [{ arm, policy: "hybrid" }]
      : [
          { arm, policy: "hybrid" },
          { arm, policy: "declare" },
        ],
  );
}

/**
 * The CI-shaped half of the gate: every arm in its own process, over the same
 * files, at a sweep of seed counts. The sweep is the measurement — one number
 * says what a run costs, the curve says what inference costs, which is the
 * thing #4's lever would remove.
 */
async function main(): Promise<void> {
  const [targetDirectory, name, seedList, repeatText, armList, pathList] =
    process.argv.slice(2);
  if (
    targetDirectory === undefined ||
    name === undefined ||
    seedList === undefined ||
    repeatText === undefined ||
    armList === undefined
  ) {
    throw new Error(
      "usage: cold <target-directory> <target> <seed-counts> <repeat> <arms> [paths]",
    );
  }

  const target = targetNamed(name);
  const configs = writeEslintConfigs(targetDirectory);
  const paths =
    pathList === undefined || pathList === ""
      ? target.lintPaths
      : pathList.split(",");
  const repeat = Number(repeatText);
  const arms = armList.split(",") as EslintArm[];
  const cells: Cell[] = [];

  const schedule = armsOf(arms);

  for (const asked of seedList.split(",").map(Number)) {
    let seeds = 0;
    if (asked === 0) restoreTree(targetDirectory, target);
    else seeds = applySeeds(targetDirectory, target, asked).length;

    const runs = new Map<string, ColdRun[]>();
    const run = async (
      arm: EslintArm,
      policy: Policy,
      keep: boolean,
    ): Promise<void> => {
      const result = await coldLint({
        targetDirectory,
        configFile: configs[arm],
        paths,
        ignore: target.ignorePaths,
        // Declare-only is the same workload with inference switched off, so it
        // is a policy on the same arm rather than an arm of its own.
        env: policy === "declare" ? { NOTHROW_COLOR_POLICY: "declare" } : {},
      });
      if (keep) {
        const key = `${arm}/${policy}`;
        runs.set(key, [...(runs.get(key) ?? []), result]);
      }
      process.stderr.write(
        `${String(seeds)} seeds · ${arm} · ${policy}${keep ? "" : " · warm-up"}: ${String(Math.round(result.processMs))} ms\n`,
      );
    };

    // Rewriting a file evicts it from the OS cache, and a cold read of 190,000
    // lines is worth tens of seconds on the machine that reads them warm — so
    // the rewrite is paid by a discarded run, and every arm runs back to back
    // inside one repeat rather than in a block of its own.
    const first = schedule[0];
    if (first !== undefined) await run(first.arm, first.policy, false);

    for (let attempt = 0; attempt < repeat; attempt += 1) {
      for (const { arm, policy } of schedule) await run(arm, policy, true);
    }

    for (const { arm, policy } of schedule) {
      cells.push({
        seeds,
        arm,
        policy,
        runs: runs.get(`${arm}/${policy}`) ?? [],
      });
    }
  }

  restoreTree(targetDirectory, target);

  const report = {
    target: target.name,
    commit: target.commit,
    paths,
    ignore: target.ignorePaths,
    repeat,
    versions: await hostVersions(targetDirectory),
    seedsPlacedIn: target.seedFiles,
    cells,
  };

  const out = fileURLToPath(new URL("../../results/", import.meta.url));
  mkdirSync(out, { recursive: true });
  // The scope is in the name because the same target is measured at more than
  // one, and a rerun at a narrower scope must not silently replace a wider one.
  writeFileSync(
    `${out}cold-${target.name}-${slug(paths)}.json`,
    `${JSON.stringify(report, undefined, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
}

function slug(paths: readonly string[]): string {
  return paths.join("+").replace(/[^A-Za-z0-9]+/g, "-");
}

await main();

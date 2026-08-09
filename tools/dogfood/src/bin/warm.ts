import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { writeArmConfigs, type Arm, type Policy } from "../configs.js";
import { hostModule, hostVersions } from "../host.js";
import { targetNamed, type Target } from "../targets.js";
import { applySeeds, restoreTree } from "../tree.js";

interface Sample {
  readonly edit: string;
  readonly arm: Arm;
  readonly policy: Policy;
  readonly ms: number;
  readonly errors: number;
}

/**
 * The editor-shaped half: one process, one live program, the same file edited
 * and re-linted. Nothing here is cold except the first lint, which is kept and
 * reported rather than discarded — the distance between it and the rest is the
 * program build the host pays once and shares (#30 §G).
 *
 * The two cycle edits are the scenarios #30 §G names: one that splits a cycle
 * group and one that merges two. What they price today is a per-file memo — the
 * engine's memo does not outlive one file's analysis — so they are a
 * measurement of what a cross-file memo would have to beat, not of an
 * invalidation this build performs.
 */
async function main(): Promise<void> {
  const [targetDirectory, name, iterationText] = process.argv.slice(2);
  if (targetDirectory === undefined || name === undefined) {
    throw new Error("usage: warm <target-directory> <target> [iterations]");
  }

  const target = targetNamed(name);
  const iterations = Number(iterationText ?? "5");
  const configs = writeArmConfigs(targetDirectory);
  const warmPath = join(targetDirectory, target.warm.file);

  const seeds = applySeeds(targetDirectory, target, target.warm.seeds);
  const base = readFileSync(warmPath, "utf8");

  const { ESLint } = await hostModule<typeof import("eslint")>(
    targetDirectory,
    "eslint",
  );

  const arms: { arm: Arm; policy: Policy }[] = [
    { arm: "baseline", policy: "hybrid" },
    { arm: "preset-compat", policy: "hybrid" },
    { arm: "preset-compat", policy: "declare" },
  ];

  const linters = new Map<Arm, InstanceType<typeof ESLint>>();
  for (const { arm } of arms) {
    if (linters.has(arm)) continue;
    linters.set(
      arm,
      new ESLint({
        cwd: targetDirectory,
        overrideConfigFile: configs[arm],
        ignorePatterns: [...target.ignorePaths],
      }),
    );
  }

  const samples: Sample[] = [];
  const lint = async (
    editName: string,
    text: string,
    arm: Arm,
    policy: Policy,
  ): Promise<void> => {
    writeFileSync(warmPath, text);
    // The lever is read when a resolver is built, so one process can measure
    // both policies against one live program.
    if (policy === "declare") process.env["NOTHROW_COLOR_POLICY"] = "declare";
    else delete process.env["NOTHROW_COLOR_POLICY"];
    const linter = linters.get(arm);
    if (linter === undefined) throw new Error(`no linter for ${arm}`);

    const started = performance.now();
    const results = await linter.lintFiles([warmPath]);
    const ms = performance.now() - started;
    samples.push({
      edit: editName,
      arm,
      policy,
      ms,
      errors: results.reduce((total, one) => total + one.errorCount, 0),
    });
    process.stderr.write(
      `${editName} · ${arm} · ${policy}: ${String(Math.round(ms))} ms\n`,
    );
  };

  // The first lint under each arm builds what the rest reuse.
  for (const { arm, policy } of arms) {
    await lint("first", base, arm, policy);
  }

  for (let round = 0; round < iterations; round += 1) {
    for (const { arm, policy } of arms) {
      await lint("touch", touched(base, samples.length), arm, policy);
    }
  }

  const anchor = bodyAnchor(target.warm.file, base);
  for (let round = 0; round < iterations; round += 1) {
    for (const { arm, policy } of arms) {
      await lint("body", edited(base, anchor, samples.length), arm, policy);
    }
  }

  const originals = new Map(
    target.cycleEdits.map((edit) => [
      edit.file,
      readFileSync(join(targetDirectory, edit.file), "utf8"),
    ]),
  );
  for (const edit of target.cycleEdits) {
    // Repeated like every other edit: one sample of a cycle edit could not be
    // told apart from one sample of anything else.
    for (let round = 0; round < iterations; round += 1) {
      for (const { arm, policy } of arms) {
        await lint(
          edit.name,
          // A distinct text every time, so each lint pays for a program update
          // exactly as the touch and body rounds do.
          touched(
            cycleEdited(targetDirectory, base, target, edit.name, originals),
            samples.length,
          ),
          arm,
          policy,
        );
      }
    }
    const original = originals.get(edit.file);
    if (original !== undefined && edit.file !== target.warm.file) {
      writeFileSync(join(targetDirectory, edit.file), original);
    }
  }

  writeFileSync(warmPath, base);
  restoreTree(targetDirectory, target);

  const out = fileURLToPath(new URL("../../results/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const report = {
    target: target.name,
    commit: target.commit,
    warmFile: target.warm.file,
    seedsAsked: target.warm.seeds,
    seedsPlaced: seeds.length,
    // What the re-linted file itself carries, which is the number the timings
    // below are per: the rest of the marks are in files this loop never lints.
    seedsInWarmFile: seeds.filter((seed) => seed.file === target.warm.file)
      .length,
    iterations,
    versions: await hostVersions(targetDirectory),
    cycleEdits: target.cycleEdits.map(({ name, description, file }) => ({
      name,
      description,
      file,
    })),
    samples,
  };
  writeFileSync(
    `${out}warm-${target.name}.json`,
    `${JSON.stringify(report, undefined, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
}

/** A comment at the end of the file: a parse, and nothing else to analyze. */
function touched(base: string, round: number): string {
  return `${base}\n// dogfood touch ${String(round)}\n`;
}

/**
 * Where a body edit goes: the first marked function in the file. An edit here
 * is the one an editor sees most — a statement typed inside a body — and it is
 * the edit a cross-file memo would have to invalidate a whole cycle group for.
 */
function bodyAnchor(fileName: string, text: string): number {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body !== undefined) {
      return statement.body.getStart(sourceFile) + 1;
    }
  }
  throw new Error(`${fileName}: no function body to edit`);
}

function edited(base: string, anchor: number, round: number): string {
  return `${base.slice(0, anchor)}\n    void ${String(round)};${base.slice(anchor)}`;
}

/**
 * The cycle edits are stated against the file they edit, which is not always
 * the file the warm loop re-lints — so the edit is written to its own file and
 * the warm file is handed back unchanged. Each application starts from the text
 * as it stood before any edit, so re-applying under the next arm is the same
 * edit rather than an edit on top of one.
 */
function cycleEdited(
  targetDirectory: string,
  base: string,
  target: Target,
  name: string,
  originals: ReadonlyMap<string, string>,
): string {
  const edit = target.cycleEdits.find((candidate) => candidate.name === name);
  if (edit === undefined) throw new Error(`no cycle edit named ${name}`);

  const before =
    edit.file === target.warm.file ? base : (originals.get(edit.file) ?? "");
  const at = before.indexOf(edit.find);
  if (at === -1) throw new Error(`${edit.file}: edit target not found`);

  const after =
    before.slice(0, at) + edit.replace + before.slice(at + edit.find.length);
  if (edit.file === target.warm.file) return after;

  writeFileSync(join(targetDirectory, edit.file), after);
  return base;
}

await main();

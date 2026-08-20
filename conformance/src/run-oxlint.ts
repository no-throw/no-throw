import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, section, type Diagnostic } from "./diagnostics.js";
import {
  runFixtureOxlint,
  runOxlintFix,
  type OxlintRun,
} from "./driver-oxlint.js";
import { loadFixtures, type Fixture } from "./fixtures.js";

/**
 * The oxlint parity pass: the same fixture corpus, through the other host.
 * What it holds is that a project produces the same diagnostics at the same
 * places with the same text whichever binary runs the rules — which is the
 * claim that makes the adapters adapters.
 *
 * Two deliberate narrowings against the ESLint passes, both stated here
 * because a narrowing nobody wrote down reads as coverage. The preset
 * fixtures stay out: their subject is an ESLint installation shape — flat
 * config merging, the plugin-object argument — and oxlint's install surface
 * is its own config file, exercised by this very runner. And the offered
 * edits are asserted as content by the ESLint passes only, because oxlint's
 * CLI output carries no suggestions; what this runner holds instead is the
 * fixer plumbing — `--fix` must change nothing, and `--fix-suggestions`
 * must produce exactly the file the fixture pins for the offer.
 */

const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixtures = loadFixtures(fixturesRoot);

const parity = fixtures.filter((fixture) => fixture.config === "rules");
const skipped = fixtures.filter((fixture) => fixture.config !== "rules");

console.log(
  "\noxlint parity — the same fixtures, the same diagnostics, through `oxlint .`.\n",
);

const failures: string[] = [];
const reports = await inPool(parity, 8, reportOf);

for (const [index, fixture] of parity.entries()) {
  const report = reports[index] ?? ["the pool lost this fixture"];
  console.log(
    `${report.length === 0 ? "PASS" : "FAIL"}  ${fixture.name} — ${fixture.description}`,
  );
  for (const line of report) console.log(`        ${line}`);
  if (report.length > 0) failures.push(fixture.name);
}

console.log(
  `\n${skipped.length} preset fixtures left to the ESLint passes: ${skipped
    .map((fixture) => fixture.name)
    .join(", ")}.`,
);

await fixerProbes();
await hostingProbes();

console.log("");
if (failures.length === 0) {
  console.log(`${parity.length} fixtures, all passing under oxlint.`);
} else {
  console.log(
    `${failures.length} of ${parity.length} fixtures failing under oxlint: ${failures.join(", ")}`,
  );
  process.exitCode = 1;
}

async function reportOf(fixture: Fixture): Promise<readonly string[]> {
  let run;
  try {
    run = await runFixtureOxlint(fixture.directory);
  } catch (error) {
    return [
      "the driver could not run this fixture:",
      `  ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  const report: string[] = [];

  if (run.foreign.length > 0) {
    report.push(
      "oxlint reported something no fixture asserts:",
      ...run.foreign.map((line) => `  ${line}`),
    );
  }

  // A refusal surfaces per file here — a rule that throws is an `Error
  // running JS plugin` diagnostic — where ESLint dies wholesale. Same text,
  // same non-zero exit, and nothing of the invariant is reported either way.
  if (fixture.refuses.length > 0) {
    const said = run.pluginErrors.join("\n");
    for (const text of fixture.refuses) {
      if (!said.includes(text)) {
        report.push(`the refusal never names ${JSON.stringify(text)}`);
      }
    }
    if (run.pluginErrors.length === 0) {
      report.push("this fixture asserts the run refuses, and it completed");
    }
    if (run.exitCode === 0) {
      report.push("a refused run exited 0");
    }
    return report;
  }

  report.push(...diedOn(run));

  const mismatch = compare(
    fixture.expected.map(withoutOffers),
    run.diagnostics,
  );
  report.push(
    ...section("expected, but not reported", mismatch.missing),
    ...section("reported, but not expected", mismatch.unexpected),
  );

  const wantErrors = fixture.expected.length > 0;
  if (wantErrors && run.exitCode === 0) {
    report.push("diagnostics were expected and the run exited 0");
  }
  if (!wantErrors && run.exitCode !== 0 && report.length === 0) {
    report.push(`a clean fixture exited ${run.exitCode}`);
  }

  return report;
}

/**
 * A rule that threw on a file, as lines to report. oxlint carries the whole
 * stack, and the first few lines are the part worth reading from a CI log.
 */
function diedOn(run: OxlintRun): readonly string[] {
  if (run.pluginErrors.length === 0) return [];
  return [
    "a rule died on a file:",
    ...run.pluginErrors.map((line) => `  ${line.split("\n", 3).join(" ")}`),
  ];
}

/**
 * The offer content is pinned by the ESLint passes; what oxlint adds is a
 * fixer channel of its own, and both of its directions are held here. The
 * expectation `suggestions` field is therefore stripped before comparing.
 */
function withoutOffers(diagnostic: Diagnostic): Diagnostic {
  return {
    file: diagnostic.file,
    line: diagnostic.line,
    column: diagnostic.column,
    endLine: diagnostic.endLine,
    endColumn: diagnostic.endColumn,
    messageId: diagnostic.messageId,
    ...(diagnostic.message === undefined ? {} : { message: diagnostic.message }),
  };
}

/**
 * The two directions of the fixer contract, each in a copy of a fixture so
 * the suite leaves no edits behind:
 *
 * - `oxlint --fix` applies fixes, and no rule of ours may carry one, so it
 *   must leave every byte alone — on the fixtures with offers, where an
 *   autofix would be likeliest to leak.
 * - `oxlint --fix-suggestions` is the reader accepting the offer, so on a
 *   fixture pinning exactly one offer it must produce exactly the file the
 *   expectation pins — which is what proves the offer oxlint carries is the
 *   edit the engine shaped.
 */
async function fixerProbes(): Promise<void> {
  const candidates = parity.filter((fixture) => {
    const pinned = fixture.expected.flatMap(
      (diagnostic) => diagnostic.suggestions ?? [],
    );
    return (
      pinned.length === 1 &&
      fixture.expected.every((diagnostic) => diagnostic.suggestions !== undefined)
    );
  });

  // A probe with nothing to probe would pass forever and hold nothing.
  if (candidates.length === 0) {
    console.log(
      "\nFAIL  fixer probes — no fixture pins exactly one offer, so they ran nothing",
    );
    failures.push("fixer probes ran nothing");
    return;
  }

  console.log("");
  for (const fixture of candidates) {
    const verdicts = await inCopy(fixture, async (directory) => {
      const problems: string[] = [];

      const before = snapshot(directory);
      await runOxlintFix(directory, "--fix");
      const afterFix = snapshot(directory);
      for (const [file, text] of before) {
        if (afterFix.get(file) !== text) {
          problems.push(`--fix rewrote ${file}, and no rule of ours may fix`);
        }
      }

      await runOxlintFix(directory, "--fix-suggestions");
      const diagnostic = fixture.expected.find(
        (entry) => (entry.suggestions?.length ?? 0) > 0,
      );
      const offer = diagnostic?.suggestions?.[0];
      if (diagnostic === undefined || offer === undefined) {
        problems.push("the candidate lost its pinned offer");
        return problems;
      }
      const edited = readFileSync(join(directory, diagnostic.file), "utf8")
        .split(/\r?\n/)
        .join("\n");
      const pinned = offer.output.join("\n");
      if (edited !== pinned) {
        problems.push(
          `--fix-suggestions did not produce the pinned offer for ${diagnostic.file}:`,
          ...edited.split("\n").map((line) => `  | ${line}`),
        );
      }

      return problems;
    });

    console.log(
      `${verdicts.length === 0 ? "PASS" : "FAIL"}  fixer probes over ${fixture.name}`,
    );
    for (const line of verdicts) console.log(`        ${line}`);
    if (verdicts.length > 0) {
      failures.push(`fixer probes over ${fixture.name}`);
    }
  }
}

/**
 * The answers this host gives where the ESLint side leaves the problem to
 * `projectService`'s parse errors: a file with no project above it, a file its
 * nearest project leaves out, and a project that cannot be read at all. No
 * fixture can hold any of them — a fixture *is* a project — so the runner
 * builds the shapes itself, and the messages have an artifact behind them the
 * way every other normative text does.
 *
 * The last two probes are about *how* the answer is reached rather than what
 * it is. This host reads a file's mark-shaped text before it decides whether
 * to build a program at all, so an unmarked file and a marked one arrive at
 * inclusion by different routes: one from the config's globbed list, one from
 * the program the globs produced. Both routes owe the same answer, and a file
 * the globs miss and an import reaches is included on either.
 */
async function hostingProbes(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "nothrow-oxlint-hosting-"));

  const project = (name: string, include: string): string => {
    const directory = join(workspace, name);
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(
      join(directory, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { strict: true }, include: [include] })}\n`,
    );
    return directory;
  };

  try {
    const loose = join(workspace, "loose");
    mkdirSync(join(loose, "src"), { recursive: true });
    writeFileSync(join(loose, "src", "index.ts"), "export const n = 1;\n");

    const scoped = project("scoped", "src");
    writeFileSync(join(scoped, "src", "included.ts"), "export const n = 1;\n");
    writeFileSync(join(scoped, "stray.ts"), "export const s = 1;\n");

    const broken = join(workspace, "broken");
    mkdirSync(join(broken, "src"), { recursive: true });
    writeFileSync(join(broken, "tsconfig.json"), "{ not a project\n");
    writeFileSync(join(broken, "src", "index.ts"), "export const n = 1;\n");

    const marked = project("marked-stray", "src");
    writeFileSync(join(marked, "src", "included.ts"), "export const n = 1;\n");
    writeFileSync(
      join(marked, "stray.ts"),
      "/** @nothrow */\nexport function s(): number {\n  return 1;\n}\n",
    );

    // The globs name `src`, and `src/index.ts` imports its way out to a file
    // they never listed. That file is the project's all the same, and only a
    // program can say so — which is the one thing the config's list cannot
    // answer, and therefore the one thing it must not answer wrongly.
    const reached = project("reached", "src");
    writeFileSync(
      join(reached, "src", "index.ts"),
      'import { helper } from "../lib/helper.js";\n\nexport const n = helper();\n',
    );
    mkdirSync(join(reached, "lib"), { recursive: true });
    writeFileSync(
      join(reached, "lib", "helper.ts"),
      "export function helper(): number {\n  return 1;\n}\n",
    );

    const probes: readonly {
      readonly name: string;
      readonly directory: string;
      /** Every diagnostic the run must produce, and nothing besides. */
      readonly expected: readonly { messageId: string; file: string }[];
    }[] = [
      {
        name: "a file with no project above it",
        directory: loose,
        expected: [{ messageId: "noProject", file: "src/index.ts" }],
      },
      {
        name: "a file its nearest project leaves out",
        directory: scoped,
        expected: [{ messageId: "outsideProject", file: "stray.ts" }],
      },
      {
        name: "a file whose project cannot be read",
        directory: broken,
        expected: [{ messageId: "brokenProject", file: "src/index.ts" }],
      },
      {
        name: "a marked file its nearest project leaves out",
        directory: marked,
        expected: [{ messageId: "outsideProject", file: "stray.ts" }],
      },
      {
        name: "a file the globs miss and an import reaches",
        directory: reached,
        expected: [],
      },
    ];

    console.log("");
    for (const probe of probes) {
      const problems: string[] = [];
      const run = await runFixtureOxlint(probe.directory);

      for (const want of probe.expected) {
        const found = run.diagnostics.filter(
          (diagnostic) =>
            diagnostic.messageId === want.messageId &&
            diagnostic.file === want.file,
        );
        if (found.length !== 1) {
          problems.push(
            `expected one ${want.messageId} on ${want.file}, saw ${found.length}`,
          );
        }
      }
      if (run.diagnostics.length !== probe.expected.length) {
        problems.push(
          `expected ${probe.expected.length} diagnostics, saw: ${run.diagnostics
            .map((diagnostic) => `${diagnostic.file} ${diagnostic.messageId}`)
            .join(", ")}`,
        );
      }
      problems.push(...diedOn(run));
      if ((run.exitCode === 0) !== (probe.expected.length === 0)) {
        problems.push(`the run exited ${run.exitCode}`);
      }

      console.log(
        `${problems.length === 0 ? "PASS" : "FAIL"}  hosting probe — ${probe.name}`,
      );
      for (const line of problems) console.log(`        ${line}`);
      if (problems.length > 0) failures.push(`hosting probe: ${probe.name}`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** A fixture copied beside the base tsconfig its own one extends. */
async function inCopy<T>(
  fixture: Fixture,
  work: (directory: string) => Promise<T>,
): Promise<T> {
  const workspace = mkdtempSync(join(tmpdir(), "nothrow-oxlint-"));
  try {
    cpSync(
      join(fixturesRoot, "tsconfig.base.json"),
      join(workspace, "tsconfig.base.json"),
    );
    const directory = join(workspace, "case");
    cpSync(fixture.directory, directory, { recursive: true });
    return await work(directory);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Every file under the directory, path to text. */
function snapshot(directory: string, prefix = ""): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [file, text] of snapshot(directory, relative)) {
        files.set(file, text);
      }
    } else {
      files.set(relative, readFileSync(join(directory, relative), "utf8"));
    }
  }
  return files;
}

async function inPool<T, R>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (;;) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await work(item);
      }
    }),
  );
  return results;
}

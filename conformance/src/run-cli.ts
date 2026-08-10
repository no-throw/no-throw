import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT_CODES,
  loadCliCases,
  type CliCase,
  type Step,
  type Verdict,
} from "./cli-cases.js";
import { compare, section, type Diagnostic } from "./diagnostics.js";
import { runFixture } from "./driver-eslint.js";
import { loadFixture } from "./fixtures.js";

const casesRoot = fileURLToPath(new URL("../cli/", import.meta.url));
const bin = fileURLToPath(
  new URL("../../packages/cli/dist/bin.js", import.meta.url),
);

const cases = loadCliCases(casesRoot);

console.log(
  "\nThe `nothrow` binary, over producer packages and consumer projects on disk.\n",
);

const failures: string[] = [];

for (const testCase of cases) {
  const report = await runCase(testCase);
  const verdict = report.length === 0 ? "PASS" : "FAIL";
  console.log(`${verdict}  ${testCase.name} — ${testCase.description}`);
  for (const line of report) console.log(`        ${line}`);
  if (report.length > 0) failures.push(testCase.name);
}

console.log("");
if (failures.length === 0) {
  console.log(`${cases.length} cases, all passing.`);
} else {
  console.log(
    `${failures.length} of ${cases.length} cases failing: ${failures.join(", ")}`,
  );
  process.exitCode = 1;
}

/**
 * Run one case in a copy of itself. A copy because the steps edit the producer
 * — a rebuilt `.js`, a mark removed — and a suite that left those edits behind
 * would pass once and then lie.
 */
async function runCase(testCase: CliCase): Promise<readonly string[]> {
  const workspace = mkdtempSync(join(tmpdir(), "nothrow-cli-"));
  try {
    cpSync(testCase.directory, workspace, { recursive: true });
    const producer = join(workspace, "producer");

    const report: string[] = [];
    for (const [index, step] of testCase.steps.entries()) {
      const lines = await runStep(step, producer, workspace);
      if (lines.length > 0) {
        report.push(`step ${index + 1} (${step.kind}):`, ...lines.map(indent));
        break;
      }
    }
    return report;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function runStep(
  step: Step,
  producer: string,
  workspace: string,
): Promise<readonly string[]> {
  switch (step.kind) {
    case "emit":
      return binaryStep("emit", step.args, producer, step);
    case "check":
      return binaryStep(
        "check",
        step.args,
        join(workspace, step.directory),
        step,
      );
    case "entries":
      return entriesStep(step, producer);
    case "absent":
      return existsSync(join(producer, step.file))
        ? [`\`${step.file}\` exists, and this step asserts it does not`]
        : [];
    case "append":
      appendFileSync(join(producer, step.file), step.text);
      return [];
    case "replace":
      return replaceStep(step, producer);
    case "consumer":
      return consumerStep(step, producer, workspace);
  }
}

function binaryStep(
  command: string,
  args: readonly string[],
  cwd: string,
  step: { readonly expect: Verdict; readonly names: readonly string[] },
): readonly string[] {
  const run = spawnSync(process.execPath, [bin, command, ...args], {
    cwd,
    encoding: "utf8",
  });

  const output = `${run.stdout}${run.stderr}`;
  const report: string[] = [];

  const expected = EXIT_CODES[step.expect];
  if (run.status !== expected) {
    report.push(
      `\`nothrow ${command} ${args.join(" ")}\` exited ${run.status}, and ` +
        `${step.expect} is ${expected}`,
    );
  }
  for (const name of step.names) {
    if (!output.includes(name)) {
      report.push(`the output never names ${JSON.stringify(name)}`);
    }
  }

  return report.length === 0
    ? []
    : [...report, "what it printed:", ...quote(output)];
}

function entriesStep(
  step: Extract<Step, { kind: "entries" }>,
  producer: string,
): readonly string[] {
  const path = join(producer, "nothrow.json");
  if (!existsSync(path)) return ["no `nothrow.json` was written"];

  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    exports?: Record<string, Record<string, unknown>>;
  };
  const report: string[] = [];

  for (const [subpath, entries] of Object.entries(step.expected)) {
    for (const [key, expected] of Object.entries(entries)) {
      const actual = manifest.exports?.[subpath]?.[key];
      if (canonical(actual) !== canonical(expected)) {
        report.push(
          `\`${subpath}\` → \`${key}\` is ${canonical(actual)}, ` +
            `expected ${canonical(expected)}`,
        );
      }
    }
  }
  return report;
}

function replaceStep(
  step: Extract<Step, { kind: "replace" }>,
  producer: string,
): readonly string[] {
  const path = join(producer, step.file);
  const before = readFileSync(path, "utf8");
  if (!before.includes(step.find)) {
    return [`\`${step.file}\` does not contain ${JSON.stringify(step.find)}`];
  }
  writeFileSync(path, before.replace(step.find, step.with));
  return [];
}

/**
 * Install the producer where a consumer resolves it from, then run the
 * consumer through the same driver every other fixture goes through.
 */
async function consumerStep(
  step: Extract<Step, { kind: "consumer" }>,
  producer: string,
  workspace: string,
): Promise<readonly string[]> {
  const packageJson = JSON.parse(
    readFileSync(join(producer, "package.json"), "utf8"),
  ) as { name?: string };
  if (packageJson.name === undefined) {
    return ["the producer's `package.json` has no `name` to install it under"];
  }

  const consumer = join(workspace, step.directory);
  cpSync(producer, join(consumer, "node_modules", packageJson.name), {
    recursive: true,
  });

  const fixture = loadFixture(consumer);
  let actual: readonly Diagnostic[];
  try {
    actual = await runFixture(consumer, fixture.config);
  } catch (error) {
    return [
      "the driver could not run the consumer:",
      `  ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  const { missing, unexpected } = compare(fixture.expected, actual);
  return [
    ...section("expected, but not reported", missing),
    ...section("reported, but not expected", unexpected),
  ];
}

/**
 * JSON with its keys in one order, so two entries compare by their facts.
 *
 * The engine has one of these too, for `--check`. Deliberately not shared: a
 * suite that compared with the implementation's own comparator could not
 * report a bug in it.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function quote(output: string): string[] {
  return output.trimEnd().split(/\r?\n/).map((line) => `  | ${line}`);
}

function indent(line: string): string {
  return `  ${line}`;
}

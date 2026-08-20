import { fileURLToPath } from "node:url";
import {
  compare,
  placeOf,
  section,
  type Diagnostic,
} from "./diagnostics.js";
import { presetArgumentReport, runFixture } from "./driver-eslint.js";
import { loadFixtures, type Fixture } from "./fixtures.js";

/** What one pass makes of one fixture: the lines explaining why it failed. */
type Check = (
  fixture: Fixture,
  actual: readonly Diagnostic[],
) => readonly string[];

const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixtures = loadFixtures(fixturesRoot);

checkPresetArgument();

const hybrid = await pass(
  "Hybrid inference — the shipped configuration, against `expected.json`.",
  (fixture, actual) => expectationReport(fixture, actual),
);

// #4's rip-out lever, maintainer-internal. The engine reads it whenever it
// builds a resolver, and builds one per file, so flipping it here is enough.
process.env["NOTHROW_COLOR_POLICY"] = "declare";

const declareOnly = await pass(
  "Declare-only — inference off, asserted as a superset of the hybrid run.",
  (fixture, actual) => supersetReport(hybrid.get(fixture.name) ?? [], actual),
);

// A superset property passes vacuously if the lever never moved, so the one
// thing it cannot check about itself is checked here: with inference off, the
// suite has to floor somewhere it did not floor before.
if (total(declareOnly) <= total(hybrid)) {
  console.log(
    "\nThe declare-only pass reported no more than the hybrid pass, so the " +
      "rip-out lever did not take effect and its superset property proved " +
      "nothing.",
  );
  process.exitCode = 1;
}

function checkPresetArgument(): void {
  const { checked, problems } = presetArgumentReport();

  if (problems.length === 0) {
    console.log(
      `\nPreset OK: ${checked} wrong arguments refused by name, and typescript-eslint's own plugin accepted.`,
    );
    return;
  }

  console.log("\nThe preset's argument check is not holding:\n");
  for (const problem of problems) console.log(`        ${problem}`);
  process.exitCode = 1;
}

/**
 * Run every fixture once, print a verdict per fixture, and hand back what was
 * reported so a later pass can be checked against it.
 */
async function pass(
  title: string,
  check: Check,
): Promise<Map<string, readonly Diagnostic[]>> {
  console.log(`\n${title}\n`);

  const reported = new Map<string, readonly Diagnostic[]>();
  const failures: string[] = [];

  for (const fixture of fixtures) {
    let report: readonly string[];

    try {
      const actual = await runFixture(fixture.directory, fixture.config);
      // Only a fixture that ran has a result a later pass can be held to.
      reported.set(fixture.name, actual);
      report =
        fixture.refuses.length > 0
          ? [
              "this fixture asserts the run refuses, naming " +
                `${fixture.refuses.map((text) => JSON.stringify(text)).join(", ")}, and it completed`,
            ]
          : check(fixture, actual);
    } catch (error) {
      report = refusalReport(fixture, error);
    }

    console.log(
      `${report.length === 0 ? "PASS" : "FAIL"}  ${fixture.name} — ${fixture.description}`,
    );
    for (const line of report) console.log(`        ${line}`);
    if (report.length > 0) failures.push(fixture.name);
  }

  console.log("");
  if (failures.length === 0) {
    console.log(`${fixtures.length} fixtures, all passing.`);
  } else {
    console.log(
      `${failures.length} of ${fixtures.length} fixtures failing: ${failures.join(", ")}`,
    );
    process.exitCode = 1;
  }

  return reported;
}

/**
 * What a run that died has to say. A fixture that asserts a refusal is passing
 * exactly when the refusal names what it says it names; for every other
 * fixture, a run that did not finish is a failure however it read.
 */
function refusalReport(fixture: Fixture, error: unknown): readonly string[] {
  const message = error instanceof Error ? error.message : String(error);

  if (fixture.refuses.length === 0) {
    return ["the driver could not run this fixture:", `  ${message}`];
  }

  const unnamed = fixture.refuses.filter((text) => !message.includes(text));
  return unnamed.length === 0
    ? []
    : [
        ...unnamed.map(
          (text) => `the refusal never names ${JSON.stringify(text)}`,
        ),
        "what it said:",
        `  ${message}`,
      ];
}

function total(reported: Map<string, readonly Diagnostic[]>): number {
  return [...reported.values()].reduce((sum, list) => sum + list.length, 0);
}

function expectationReport(
  fixture: Fixture,
  actual: readonly Diagnostic[],
): string[] {
  const { missing, unexpected } = compare(fixture.expected, actual);
  return [
    ...section("expected, but not reported", missing),
    ...section("reported, but not expected", unexpected),
  ];
}

/**
 * Turning inference off may only ever *add* diagnostics — that is "strictly
 * tightening, never unsound" written as something a machine can check, and it
 * is what keeps the rip-out lever honest without opening the core's API.
 *
 * Places are compared, not text: declare-only floors exactly where the hybrid
 * run reads a body, so the reason a diagnostic gives differs there by design.
 */
function supersetReport(
  hybridDiagnostics: readonly Diagnostic[],
  actual: readonly Diagnostic[],
): string[] {
  const places = new Set(actual.map(placeOf));
  const lost = hybridDiagnostics.filter(
    (diagnostic) => !places.has(placeOf(diagnostic)),
  );
  return section("reported by the hybrid run, but lost with inference off", lost);
}

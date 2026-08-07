import { fileURLToPath } from "node:url";
import {
  byPosition,
  compare,
  formatDiagnostic,
  placeOf,
  type Diagnostic,
} from "./diagnostics.js";
import { runFixture } from "./driver-eslint.js";
import { loadFixtures, type Fixture } from "./fixtures.js";

/** What one pass makes of one fixture: the lines explaining why it failed. */
type Check = (
  fixture: Fixture,
  actual: readonly Diagnostic[],
) => readonly string[];

const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixtures = loadFixtures(fixturesRoot);

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
      report = check(fixture, actual);
    } catch (error) {
      report = [
        "the driver could not run this fixture:",
        `  ${error instanceof Error ? error.message : String(error)}`,
      ];
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

function section(title: string, diagnostics: readonly Diagnostic[]): string[] {
  if (diagnostics.length === 0) return [];
  return [
    `${title}:`,
    ...[...diagnostics]
      .sort(byPosition)
      .map((diagnostic) => `  ${formatDiagnostic(diagnostic)}`),
  ];
}

import { fileURLToPath } from "node:url";
import {
  byPosition,
  compare,
  formatDiagnostic,
  type Diagnostic,
} from "./diagnostics.js";
import { runFixture } from "./driver-eslint.js";
import { loadFixtures, type Fixture } from "./fixtures.js";

const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

const fixtures = loadFixtures(fixturesRoot);
const failures: string[] = [];

for (const fixture of fixtures) {
  const report = await check(fixture);
  const verdict = report.length === 0 ? "PASS" : "FAIL";
  console.log(`${verdict}  ${fixture.name} — ${fixture.description}`);
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

/** The lines explaining why the fixture failed; empty when it passed. */
async function check(fixture: Fixture): Promise<string[]> {
  let actual: readonly Diagnostic[];
  try {
    actual = await runFixture(fixture.directory);
  } catch (error) {
    return [
      "the driver could not run this fixture:",
      `  ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  const { missing, unexpected } = compare(fixture.expected, actual);
  return [
    ...section("expected, but not reported", missing),
    ...section("reported, but not expected", unexpected),
  ];
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

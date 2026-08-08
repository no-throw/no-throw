/**
 * Run the real `@nothrow/core` engine over the conformance fixtures twice —
 * once on the in-process TypeScript 6 checker, once on a TypeScript 7 client —
 * and diff what each reports.
 *
 * This is #81's "does the suite pass unchanged on tsgo?" reduced to what it
 * actually asks. The conformance suite drives ESLint, and ESLint's parser is
 * TypeScript's own, so running the *suite* on tsgo would be a measurement of
 * typescript-eslint. What the engine owns is `analyzeSourceFile`, so both
 * backends are pointed at that, over the suite's own fixture sources.
 *
 * The backends cannot share a process: the TypeScript 7 one works by resolving
 * `typescript` to a shim for everything under the engine, which is a
 * module-level substitution and therefore all-or-nothing. So each runs in its
 * own child and this diffs the two reports.
 *
 *   node tsgo-conformance.mjs [fixture...]            # both, diffed
 *   node tsgo-conformance.mjs --backend ts6 [...]     # one, as JSON
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.resolve("../../conformance/fixtures");
const HERE = fileURLToPath(import.meta.url);

function fixtureNames(requested) {
  const names =
    requested.length > 0
      ? requested
      : readdirSync(FIXTURES, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
  return names.filter((name) =>
    existsSync(path.join(FIXTURES, name, "tsconfig.json")),
  );
}

function run(backend, names) {
  const args = backend === "ts7" ? ["--import", "./tsgo/register.mjs"] : [];
  const child = spawnSync(
    process.execPath,
    [...args, HERE, "--backend", backend, ...names],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    console.error(child.stderr || child.stdout);
    throw new Error(`${backend} backend exited ${child.status}`);
  }
  return JSON.parse(child.stdout);
}

const argv = process.argv.slice(2);
const backendAt = argv.indexOf("--backend");

if (backendAt === -1) {
  const names = fixtureNames(argv);
  const ts6 = run("ts6", names);
  const ts7 = run("ts7", names);

  let agreed = 0;
  const differed = [];
  let ts6Findings = 0;
  let ts7Findings = 0;

  for (const name of names) {
    const a = ts6.reports[name] ?? {};
    const b = ts7.reports[name] ?? {};
    ts6Findings += Object.values(a).flat().length;
    ts7Findings += Object.values(b).flat().length;

    const files = new Set([...Object.keys(a), ...Object.keys(b)]);
    const mismatched = [...files].filter(
      (file) =>
        JSON.stringify(a[file] ?? []) !== JSON.stringify(b[file] ?? []),
    );
    if (mismatched.length === 0) agreed += 1;
    else differed.push([name, mismatched, a, b]);
  }

  console.log(
    `\n${agreed} fixtures agree, ${differed.length} differ` +
      `  |  errored: ${ts6.errors.length} on TypeScript 6, ${ts7.errors.length} on TypeScript 7`,
  );
  // Two empty reports agree, so the finding counts are what stop a run that
  // analyzed nothing from claiming total agreement.
  console.log(
    `findings: ${ts6Findings} on TypeScript 6, ${ts7Findings} on TypeScript 7`,
  );

  for (const [label, errors] of [
    ["TypeScript 6", ts6.errors],
    ["TypeScript 7", ts7.errors],
  ]) {
    if (errors.length === 0) continue;
    const bySymptom = new Map();
    for (const [name, message] of errors) {
      const key = message.split("\n")[0].slice(0, 140);
      bySymptom.set(key, [...(bySymptom.get(key) ?? []), name]);
    }
    console.log(`\n${label} errors:`);
    for (const [symptom, names] of [...bySymptom].sort(
      (x, y) => y[1].length - x[1].length,
    )) {
      console.log(`  ${names.length}x  ${symptom}`);
      console.log(`        e.g. ${names.slice(0, 3).join(", ")}`);
    }
  }

  if (differed.length > 0) {
    console.log("\ndiffered:");
    for (const [name, files, a, b] of differed.slice(0, 15)) {
      console.log(`  ${name}`);
      for (const file of files) {
        console.log(`    ${file}`);
        console.log(`      ts6: ${JSON.stringify(a[file] ?? [])}`);
        console.log(`      ts7: ${JSON.stringify(b[file] ?? [])}`);
      }
    }
    if (differed.length > 15) {
      console.log(`  ... and ${differed.length - 15} more`);
    }
  }

  if (Object.keys(ts7.gaps).length > 0) {
    console.log("\nmissing tsgo operations reached:");
    for (const [gap, count] of Object.entries(ts7.gaps).sort(
      (x, y) => y[1] - x[1],
    )) {
      console.log(`  ${gap}  (in ${count} fixtures)`);
    }
  }

  process.exitCode = differed.length === 0 && ts7.errors.length === 0 ? 0 : 1;
} else {
  const backend = argv[backendAt + 1];
  const names = argv.slice(backendAt + 2);
  const { analyzeOne } = await (backend === "ts7"
    ? import("./tsgo/backend-ts7.mjs")
    : import("./tsgo/backend-ts6.mjs"));

  const reports = {};
  const errors = [];
  const gaps = {};

  for (const name of names) {
    try {
      const result = analyzeOne(path.join(FIXTURES, name));
      reports[name] = result.reports;
      for (const gap of result.gaps ?? []) gaps[gap] = (gaps[gap] ?? 0) + 1;
    } catch (error) {
      errors.push([name, String(error.message)]);
    }
  }

  process.stdout.write(JSON.stringify({ reports, errors, gaps }));
}

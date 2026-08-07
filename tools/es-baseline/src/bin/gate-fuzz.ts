import {
  baselineData,
  collectLibMembers,
  createLibProgram,
} from "@nothrow/core/baseline";
import ts from "typescript";

import { formatCounterexample } from "../gates/fuzz.js";
import { claimsOf, runFuzzGate, type Claim } from "../gates/run.js";

/**
 * Known-throwing members planted as clean, to prove the gate can fail. Each is
 * refuted by an argument or receiver the declared type plainly admits, so a
 * green run here would mean the gate had stopped being evidence.
 */
const PLANTED = ["JSON#parse", "Array#pop", "decodeURIComponent"];

const selfCheck = process.argv.includes("--self-check");

const data = baselineData();
const lib = createLibProgram(ts);
const members = collectLibMembers(lib);

const claims = new Map<string, Claim>(claimsOf(data));
if (selfCheck) {
  for (const key of PLANTED) {
    claims.set(key, { cleanCall: true, cleanGet: false });
  }
}

const throwing = new Set<string>();
for (const entries of Object.values(data.libs)) {
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.color === "throwing") throwing.add(key);
  }
}

const report = runFuzzGate(lib, members, claims, selfCheck ? new Set() : throwing);

console.log(`clean claims probed:   ${report.probed.length}`);
console.log(`unprobed:              ${report.unprobed.length}`);
console.log(
  `probed to the budget:  ${report.probed.filter((result) => result.truncated).length} (not exhaustive)`,
);
console.log(`counterexamples:       ${report.counterexamples.length}`);
if (!selfCheck) {
  const { reproduced, attempted } = report.sensitivity;
  const percent = attempted === 0 ? 0 : Math.round((reproduced / attempted) * 100);
  console.log(
    `sensitivity:           ${reproduced}/${attempted} (${percent}%) — a green gate is the absence of a refutation, not evidence of cleanliness`,
  );
}

if (selfCheck) {
  const refuted = new Set(report.counterexamples.map((found) => found.key));
  const missed = PLANTED.filter((key) => !refuted.has(key));
  for (const key of PLANTED) {
    const found = report.counterexamples.find(
      (candidate) => candidate.key === key,
    );
    if (found !== undefined) console.log(`  refuted ${formatCounterexample(found)}`);
  }
  if (missed.length > 0) {
    console.error(
      `\nself-check FAILED: the gate did not refute ${missed.join(", ")}. A gate that cannot fail is not a gate.`,
    );
    process.exit(1);
  }
  console.log(`\nself-check OK: every planted false-clean was refuted.`);
  process.exit(0);
}

if (report.counterexamples.length > 0) {
  console.error("\ncounterexamples to a shipped clean entry:");
  for (const found of report.counterexamples.slice(0, 40)) {
    console.error(`  ${formatCounterexample(found)}`);
  }
  process.exit(1);
}

if (report.unprobed.length > 0) {
  console.error(
    `\n${report.unprobed.length} shipped clean claim(s) the gate cannot reach. Unprobed entries must ship floored — regenerate the baseline:`,
  );
  for (const result of report.unprobed.slice(0, 20)) {
    console.error(`  ${result.key.padEnd(38)} ${result.skipped}`);
  }
  process.exit(1);
}

console.log("\nhostile fuzz gate: no counterexample.");

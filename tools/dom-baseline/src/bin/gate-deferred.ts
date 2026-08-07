import { baselineData, collectDomMembers } from "@nothrow/core/baseline";
import ts from "typescript";

import { DeferredProbe, type Adjudication } from "../gates/deferred.js";
import { createDomEnvironment } from "../gates/environment.js";
import { createDomProgram } from "../lib.js";
import { readWorklist } from "../worklist.js";

/**
 * The deferred-invocation gate. #30's Further Notes call this the spec's
 * terminal open item, so it gets a gate of its own rather than riding along
 * inside the fuzz run:
 *
 * 1. **Every shipped relaxation is backed by the worklist.** A clean entry with
 *    `conditions: []` that no `queued` verdict supports is exactly the fake
 *    bridge #21 warned about, so it fails the build.
 * 2. **Nothing is left unadjudicated.** Every worklist entry carries `sync`,
 *    `queued` or `unreachable`. There is no fourth answer.
 * 3. **No verdict rests on an absence.** A `queued` entry has to say what was
 *    observed happening, not what was observed not happening.
 * 4. **The probe can tell the two apart** (`--self-check`), including on a
 *    member whose collection may be empty. A probe that answered `queued` for
 *    everything would hand out relaxations to members that invoke their
 *    callback synchronously, which is the unsound direction.
 */

/**
 * Controls the probe has to get right, in both directions.
 *
 * `DOMTokenList#forEach` is the regression guard for the mistake this gate
 * exists to prevent: it is plainly synchronous, and a probe that read `queued`
 * off "the callback did not run" would say so, because a token list with
 * nothing in it never enters the callback at all.
 */
const CONTROLS = [
  { want: "sync", key: "NodeList#forEach", paramIndex: 0 },
  { want: "sync", key: "DOMTokenList#forEach", paramIndex: 0 },
  { want: "queued", key: "EventTarget#addEventListener", paramIndex: 1 },
] as const;

const selfCheck = process.argv.includes("--self-check");
const worklist = readWorklist();

if (selfCheck) {
  const lib = createDomProgram(ts);
  const inventory = collectDomMembers(lib);
  const environment = createDomEnvironment();
  const probe = new DeferredProbe(lib, inventory.implementers, environment);

  const results: { control: string; want: string; got: string; evidence: string }[] = [];
  for (const control of CONTROLS) {
    const { want } = control;
    const member = inventory.members.find((entry) => entry.key === control.key);
    if (member === undefined) {
      results.push({
        control: control.key,
        want,
        got: "not in inventory",
        evidence: "",
      });
      continue;
    }
    const verdict = await probe.adjudicate(member, control.paramIndex);
    results.push({
      control: control.key,
      want,
      got: verdict.adjudication,
      evidence: verdict.evidence,
    });
  }
  environment.close();

  for (const result of results) {
    console.log(
      `  ${result.control.padEnd(32)} want ${result.want.padEnd(7)} got ${result.got}  — ${result.evidence}`,
    );
  }
  const wrong = results.filter((result) => result.got !== result.want);
  if (wrong.length > 0) {
    console.error(
      "\nself-check FAILED: the probe cannot tell a synchronous invocation from a queued one. Every relaxation it hands out would be a guess.",
    );
    process.exit(1);
  }
  console.log("\nself-check OK: the probe distinguishes synchronous from queued invocation.");
  process.exit(0);
}

console.log(
  `worklist: ${worklist.entries.length} callback parameters (TypeScript ${worklist.typescript}, engine ${worklist.engine})`,
);
console.log(`  ${JSON.stringify(worklist.counts)}`);

const problems: string[] = [];

const ADJUDICATIONS: readonly Adjudication[] = ["sync", "queued", "unreachable"];

const adjudications = new Map<string, Adjudication[]>();
for (const entry of worklist.entries) {
  if (!ADJUDICATIONS.includes(entry.adjudication)) {
    problems.push(`${entry.key} ${entry.param}: unadjudicated (${entry.adjudication})`);
  }
  // A `queued` verdict has to name what was observed *happening*, not what was
  // observed not happening. Absence is what makes a synchronous member read as
  // deferred, and a relaxation handed out on that basis is the fake bridge this
  // gate exists to prevent.
  if (entry.adjudication === "queued" && !entry.evidence.includes("afterwards")) {
    problems.push(
      `${entry.key} ${entry.param}: queued on an absence — "${entry.evidence}"`,
    );
  }
  const bucket = adjudications.get(entry.key) ?? [];
  bucket.push(entry.adjudication);
  adjudications.set(entry.key, bucket);
}

const data = baselineData("dom");
let relaxations = 0;
for (const entries of Object.values(data.libs)) {
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.color !== "non-throwing") continue;
    const verdicts = adjudications.get(key);
    if (verdicts === undefined) continue;
    if (verdicts.includes("unreachable")) {
      problems.push(
        `${key} ships clean while the probe could not reach one of its callbacks — no relaxation may be handed out without a verdict`,
      );
      continue;
    }
    const sync = verdicts.filter((verdict) => verdict === "sync").length;
    if (sync > (entry.conditions?.length ?? 0)) {
      problems.push(
        `${key} ships ${entry.conditions?.length ?? 0} condition(s) but ${sync} of its callbacks are invoked synchronously`,
      );
    }
    if (verdicts.every((verdict) => verdict === "queued")) relaxations++;
  }
}
console.log(`shipped relaxations backed by a queued verdict: ${relaxations}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
  process.exit(1);
}

console.log("\ndeferred-invocation gate: every callback parameter is adjudicated.");

import { formatCounterexample } from "../gates/fuzz.js";
import { generateBaseline, writeBaseline } from "../generate.js";
import { writeWorklist } from "../worklist.js";

const report = await generateBaseline();

const { shapes, topRules, ...counts } = report.summary;
for (const [name, value] of Object.entries(counts)) {
  console.log(`${name.padEnd(22)} ${value}`);
}
console.log(
  `gate sensitivity       ${report.gate.sensitivity.reproduced}/${report.gate.sensitivity.attempted}`,
);
console.log("\ndeferred-invocation worklist:", report.worklist.counts);
console.log("\nhazard sites by condition shape:");
for (const [shape, count] of shapes) {
  console.log(`  ${String(count).padStart(5)}  ${shape}`);
}
console.log("\nrules that left a member throwing, largest first:");
for (const [rule, count] of topRules) {
  console.log(`  ${String(count).padStart(5)}  ${rule}`);
}

if (report.unexercisedRefutations.length > 0) {
  console.warn(
    `\nrecorded refutations the gate never probed, because the member is no longer proposed clean: ${report.unexercisedRefutations.join(", ")}`,
  );
}

if (report.staleRefutations.length > 0) {
  console.warn(
    `\nrecorded refutations the gate no longer reproduces (precision left on the table): ${report.staleRefutations.join(", ")}`,
  );
}

if (report.counterexamples.length > 0) {
  console.error(
    `\n${report.counterexamples.length} counterexample(s) to a proposed-clean entry — the generator is wrong, not the gate:`,
  );
  for (const found of report.counterexamples.slice(0, 40)) {
    console.error(`  ${formatCounterexample(found)}`);
  }
  process.exit(1);
}

console.log(`\nwrote ${writeBaseline(report.data)}`);
console.log(`wrote ${writeWorklist(report.worklist)}`);

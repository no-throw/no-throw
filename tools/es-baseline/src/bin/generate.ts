import { formatCounterexample, formatUnrefuted } from "../gates/fuzz.js";
import { generateBaseline, writeBaseline } from "../generate.js";

const report = generateBaseline();

const { reviewRules, ...counts } = report.summary;
for (const [name, value] of Object.entries(counts)) {
  console.log(`${name.padEnd(18)} ${value}`);
}
console.log("\nresidue — condition shapes with no rule, largest first:");
for (const [rule, count] of reviewRules) {
  console.log(`  ${String(count).padStart(4)}  ${rule}`);
}
console.log(
  `gate sensitivity   ${report.gate.sensitivity.reproduced}/${report.gate.sensitivity.attempted}`,
);
for (const line of formatUnrefuted(report.gate.unrefuted)) console.log(line);

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

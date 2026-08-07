import { generateBaseline, writeBaseline } from "../generate.js";

const report = generateBaseline();

for (const [name, value] of Object.entries(report.summary)) {
  console.log(`${name.padEnd(18)} ${value}`);
}
console.log(
  `gate sensitivity   ${report.gate.sensitivity.reproduced}/${report.gate.sensitivity.attempted}`,
);

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
    console.error(
      `  ${found.key.padEnd(38)} ${found.probe} ${found.error}: ${found.message} [receiver ${found.receiver}, args ${JSON.stringify(found.args)}]`,
    );
  }
  process.exit(1);
}

console.log(`\nwrote ${writeBaseline(report.data)}`);

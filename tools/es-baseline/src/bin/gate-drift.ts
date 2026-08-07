import { pathToFileURL } from "node:url";

import ts from "typescript";

import {
  currentSymbolSet,
  diffSymbols,
  recordedSymbolSet,
  type SymbolSet,
} from "../gates/drift.js";

const args = process.argv.slice(2);
const selfCheck = args.includes("--self-check");
const againstAt = args.indexOf("--against");
const against = againstAt < 0 ? undefined : args[againstAt + 1];

const current = currentSymbolSet(ts);

let before: SymbolSet;
if (against !== undefined) {
  const other = (await import(pathToFileURL(against).href)) as {
    default?: typeof ts;
  };
  const api = other.default ?? (other as unknown as typeof ts);
  before = currentSymbolSet(api);
} else {
  before = recordedSymbolSet();
}

if (selfCheck) {
  // An injected diff in both directions: a member that vanished and one that
  // appeared. A gate that reports neither is not watching anything.
  const removed = before.members[0];
  if (removed === undefined) {
    console.error("self-check FAILED: the recorded symbol set is empty.");
    process.exit(1);
  }
  const injected: SymbolSet = {
    typescript: current.typescript,
    members: [
      ...current.members.filter((member) => member !== removed),
      "Injected#member",
    ].sort(),
  };
  const report = diffSymbols(before, injected);
  const sawAdded = report.added.includes("Injected#member");
  const sawRemoved = report.removed.includes(removed);
  console.log(`added reported:   ${sawAdded} (${report.added.join(", ")})`);
  console.log(`removed reported: ${sawRemoved} (${report.removed.join(", ")})`);
  if (!sawAdded || !sawRemoved) {
    console.error("\nself-check FAILED: the injected diff was not reported.");
    process.exit(1);
  }
  console.log("\nself-check OK: the drift gate reports added and removed members.");
  process.exit(0);
}

const report = diffSymbols(before, current);
console.log(
  `lib symbols: ${before.members.length} (TypeScript ${before.typescript}) → ${current.members.length} (TypeScript ${current.typescript})`,
);
console.log(`added:   ${report.added.length}`);
for (const member of report.added.slice(0, 40)) console.log(`  + ${member}`);
console.log(`removed: ${report.removed.length}`);
for (const member of report.removed.slice(0, 40)) console.log(`  - ${member}`);

if (report.added.length > 0) {
  console.log(
    "\nNewcomers have no entry and therefore floor. Regenerate the baseline to classify them.",
  );
}

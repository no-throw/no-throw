// Diagnostic text is normative, and the adoption ladder teaches a floor by
// quoting one. A quotation nothing checks drifts from the rule that produces
// it, and the drift is invisible: the README still reads as if the outs it
// names are the outs a reader will see in CI.
//
// So every ```text block in the root README has to be a message some fixture
// asserts, character for character once the hard wrap is undone. That fence is
// what marks a *whole* message; the elided fragments inside the `ts` samples
// are illustrations, and there is nothing verbatim in them to hold.
//
// A refusal is normative in the same way and for the same reason — it is text a
// reader acts on from the CI log alone — so what a fixture's `refuses` names
// counts here exactly as a diagnostic's `message` does.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The hard wrap is the README's; the message is one line. */
function unwrap(block) {
  return block.trim().split(/\s*\n\s*/).join(" ");
}

function quotedDiagnostics() {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  return [...readme.matchAll(/^```text\r?\n([\s\S]*?)^```/gm)].map((match) =>
    unwrap(match[1]),
  );
}

function assertedMessages() {
  const fixtures = join(root, "conformance", "fixtures");
  const messages = new Set();

  for (const entry of readdirSync(fixtures, { withFileTypes: true })) {
    // Every fixture directory has one, so an unreadable file is a broken
    // fixture rather than a directory to skip — swallowing it here would
    // report the README as drifted for a reason that is not the README's.
    if (!entry.isDirectory()) continue;
    const path = join(fixtures, entry.name, "expected.json");
    const expected = JSON.parse(readFileSync(path, "utf8"));
    for (const diagnostic of expected.diagnostics ?? []) {
      if (typeof diagnostic.message === "string") {
        messages.add(diagnostic.message);
      }
    }
    for (const refusal of expected.refuses ?? []) {
      if (typeof refusal === "string") messages.add(refusal);
    }
  }

  return messages;
}

const quoted = quotedDiagnostics();
if (quoted.length === 0) {
  console.error(
    "The README quotes no diagnostic text. If a quotation was removed, remove this check with it; if it merely lost its `text` fence, put the fence back — an unfenced quotation is one nothing holds.",
  );
  process.exit(1);
}

const asserted = assertedMessages();
const drifted = quoted.filter((message) => !asserted.has(message));

if (drifted.length > 0) {
  console.error(
    `The README quotes ${drifted.length} diagnostic${drifted.length === 1 ? "" : "s"} no fixture asserts:\n`,
  );
  for (const message of drifted) console.error(`  ${message}\n`);
  console.error(
    "Either the message changed and the README did not, or the README quotes text the suite never pins. Both are drift.",
  );
  process.exit(1);
}

console.log(
  `Docs OK: ${quoted.length} quoted ${quoted.length === 1 ? "diagnostic matches" : "diagnostics match"} what the suite asserts.`,
);

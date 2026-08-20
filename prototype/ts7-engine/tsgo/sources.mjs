/** What both backends agree counts as a fixture's own source, and how a
 * finding is written down so the two reports can be compared as text. */
import { readdirSync } from "node:fs";
import path from "node:path";

export function sourcesIn(root) {
  const files = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.[cm]?tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.add(path.resolve(full));
      }
    }
  };
  walk(root);
  return files;
}

/** Kind plus position: what the rule reports, minus the message wording. */
export function report(findings) {
  return findings
    .map((finding) => {
      const file = finding.node.getSourceFile();
      const { line, character } = file.getLineAndCharacterOfPosition(
        finding.node.getStart(file),
      );
      return `${finding.kind} @ ${line + 1}:${character + 1}`;
    })
    .sort();
}

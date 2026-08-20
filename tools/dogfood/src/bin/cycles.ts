import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callGraphAt, type Group } from "../graph.js";
import { targetNamed } from "../targets.js";
import { restoreTree } from "../tree.js";

interface AnchorGroup {
  readonly size: number;
  readonly members: readonly string[];
}

/**
 * What the two cycle edits actually do to the condensation. #30 §G says an edit
 * can split a cycle group or merge two, and prices invalidation on that; a
 * report that shows the timing of an edit without showing that the edit had
 * that effect is asserting the interesting half.
 */
function main(): void {
  const [targetDirectory, name, tsconfig, scope] = process.argv.slice(2);
  if (
    targetDirectory === undefined ||
    name === undefined ||
    tsconfig === undefined
  ) {
    throw new Error(
      "usage: cycles <target-directory> <target> <tsconfig> [scope]",
    );
  }

  const target = targetNamed(name);
  restoreTree(targetDirectory, target);

  const measure = (): AnchorGroup => {
    const graph = callGraphAt(targetDirectory, tsconfig, scope ?? "");
    const group = graph.groups.find(holds(target.cycleAnchor));
    return {
      size: group?.members.length ?? 0,
      members: (group?.members ?? []).map((member) => member.name),
    };
  };

  const before = measure();
  process.stderr.write(`before: ${String(before.size)}\n`);

  const after: Record<string, AnchorGroup> = {};
  for (const edit of target.cycleEdits) {
    const path = join(targetDirectory, edit.file);
    const original = readFileSync(path, "utf8");
    const at = original.indexOf(edit.find);
    if (at === -1) throw new Error(`${edit.file}: edit target not found`);

    writeFileSync(
      path,
      original.slice(0, at) +
        edit.replace +
        original.slice(at + edit.find.length),
    );
    const group = measure();
    after[edit.name] = group;
    writeFileSync(path, original);
    process.stderr.write(`${edit.name}: ${String(group.size)}\n`);
  }

  const out = fileURLToPath(new URL("../../results/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const report = {
    target: target.name,
    commit: target.commit,
    anchor: target.cycleAnchor,
    before,
    after,
    edits: target.cycleEdits,
  };
  writeFileSync(
    `${out}cycles-${target.name}.json`,
    `${JSON.stringify(report, undefined, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
}

function holds(name: string): (group: Group) => boolean {
  return (group) => group.members.some((member) => member.name === name);
}

main();

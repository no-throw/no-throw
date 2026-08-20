import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertMarksBind, markSource, type Seed } from "./seeds.js";
import type { Target } from "./targets.js";

/**
 * Pristine copies of every file the harness touches. A `git checkout` would do
 * the same job, but the tree is also where an arm's numbers come from: a
 * restore that depends on the checkout's index is one more thing that can be
 * wrong without saying so.
 */
const BACKUP = ".dogfood-backup";

/**
 * Mark `count` real functions across `files`, spread evenly over them and
 * evenly within each, and hand back what was marked. Restoring first is the
 * caller's — each gate has its own idea of which files are in play, and that
 * set is wider than the one being marked wherever a gate also edits.
 *
 * A file with fewer candidates than its share contributes what it has: the
 * number that goes in the report is the number placed, not the number asked
 * for.
 */
export function markFiles(
  targetDirectory: string,
  files: readonly string[],
  count: number,
): readonly Seed[] {
  const share = Math.ceil(count / files.length);
  const seeds: Seed[] = [];

  for (const file of files) {
    if (seeds.length >= count) break;

    const path = join(targetDirectory, file);
    const original = readFileSync(path, "utf8");
    const marked = markSource(
      file,
      original,
      Math.min(share, count - seeds.length),
    );
    if (marked.seeds.length === 0) continue;

    assertMarksBind(file, marked.text, marked.seeds.length);
    backup(targetDirectory, file, original);
    writeFileSync(path, marked.text);
    seeds.push(...marked.seeds);
  }

  return seeds;
}

/** Every named file as it was before the harness first wrote to it. */
export function restoreFiles(
  targetDirectory: string,
  files: readonly string[],
): void {
  for (const file of files) {
    const saved = join(targetDirectory, BACKUP, file);
    if (!existsSync(saved)) continue;
    writeFileSync(join(targetDirectory, file), readFileSync(saved, "utf8"));
  }
}

/** The ESLint gate's pair, over the files its target descriptor names. */
export function applySeeds(
  targetDirectory: string,
  target: Target,
  count: number,
): readonly Seed[] {
  restoreTree(targetDirectory, target);
  return markFiles(targetDirectory, target.seedFiles, count);
}

export function restoreTree(targetDirectory: string, target: Target): void {
  restoreFiles(targetDirectory, [
    ...target.seedFiles,
    ...target.cycleEdits.map((edit) => edit.file),
  ]);
}

/** Only the first write of a file is its original; later ones are our own. */
function backup(targetDirectory: string, file: string, text: string): void {
  const path = join(targetDirectory, BACKUP, file);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

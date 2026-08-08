/**
 * How fast the `unstable/` surface moves, since that is what a pin has to
 * survive. #81 asks what would make depending on a dated nightly safe; the
 * answer starts with knowing whether the surface churns daily, monthly, or not
 * at all.
 *
 * Downloads a few historical nightlies into a scratch tree and diffs the
 * `Checker` method set against the pinned one. No server is started — this
 * reads the shipped `.d.ts`.
 *
 * Usage: node api-churn.mjs [version...]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PINNED = "7.0.0-dev.20260707.2";
const versions =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [
        "7.0.0-dev.20251007.1",
        "7.0.0-dev.20260107.1",
        "7.0.0-dev.20260407.1",
        "7.0.0-dev.20260607.1",
        PINNED,
      ];

const scratch = path.resolve("fixtures/churn");

/** The `Checker` interface's own members, read off the shipped declaration. */
function checkerSurface(root) {
  const api = path.join(
    root,
    "node_modules/@typescript/native-preview/dist/api/sync/api.d.ts",
  );
  if (!existsSync(api)) return undefined;

  const text = readFileSync(api, "utf8");
  const start = text.indexOf("export declare class Checker");
  if (start === -1) return undefined;

  // Members up to the class's closing brace at column 0.
  const end = text.indexOf("\n}", start);
  const body = text.slice(start, end === -1 ? undefined : end);
  return new Set(
    [...body.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9_]*)\(/gmu)].map((m) => m[1]),
  );
}

function fetchVersion(version) {
  const root = path.join(scratch, version);
  if (!existsSync(path.join(root, "node_modules"))) {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "churn", private: true, version: "0.0.0" }),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--no-optional",
        `@typescript/native-preview@${version}`,
      ],
      { cwd: root, stdio: "pipe", shell: process.platform === "win32" },
    );
  }
  return checkerSurface(root);
}

const surfaces = new Map();
for (const version of versions) {
  try {
    const surface = fetchVersion(version);
    surfaces.set(version, surface);
    console.log(
      `${version.padEnd(24)} ${surface === undefined ? "no unstable/sync Checker" : `${surface.size} Checker methods`}`,
    );
  } catch (error) {
    console.log(`${version.padEnd(24)} unavailable: ${String(error.message).slice(0, 80)}`);
  }
}

const pinned = surfaces.get(PINNED);
if (pinned !== undefined) {
  console.log(`\nagainst the pin (${PINNED}):\n`);
  for (const [version, surface] of surfaces) {
    if (version === PINNED || surface === undefined) continue;
    const removed = [...surface].filter((name) => !pinned.has(name));
    const added = [...pinned].filter((name) => !surface.has(name));
    console.log(
      `  ${version.padEnd(24)} ${String(added.length).padStart(3)} added, ${String(removed.length).padStart(3)} dropped since`,
    );
    if (removed.length > 0) console.log(`      dropped: ${removed.join(", ")}`);
    if (added.length > 0 && added.length <= 12) {
      console.log(`      added:   ${added.join(", ")}`);
    }
  }
}

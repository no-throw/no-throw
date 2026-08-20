// A peer range is a claim about what a consumer may install a published package
// against, and the defect a wrong one causes is an install-time defect: an unmet
// peer warning, or an outright refusal under `strict-peer-dependencies=true`.
// Running the suite answers a different question and cannot catch it — the
// matrices resolve the dependency under test through a pnpm override, and an
// override rewrites peer ranges, so no conflict survives to be reported.
//
// So the gates install what would be published, the way a consumer installs it.
// Both of them want this machinery, and the Windows quoting below is the kind of
// workaround that must not be fixed in one copy and left wrong in the other.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// On Windows `pnpm` may be a `.cmd`, which Node refuses to spawn without a
// shell, and a shell wants its arguments quoted — the temp directories below can
// sit under a path with a space in it.
export function pnpm(args, options) {
  return process.platform === "win32"
    ? execFileSync(
        "pnpm",
        args.map((argument) => `"${argument}"`),
        { ...options, shell: true },
      )
    : execFileSync("pnpm", args, options);
}

/** Pack a workspace package into `destination`, returning the tarball path. */
export function pack(packageDirectory, destination) {
  const output = pnpm(["pack", "--pack-destination", destination], {
    cwd: join(repoRoot, packageDirectory),
    encoding: "utf8",
  });
  return output.trim().split("\n").at(-1).trim();
}

/**
 * Install `dependencies` into a throwaway project under
 * `strict-peer-dependencies=true`, so an unmet peer is a refusal rather than a
 * warning nobody reads.
 *
 * Returns whether pnpm refused and what it said. Callers need the output as
 * well as the verdict, because a refusal on its own does not say who refused.
 *
 * Read that output carefully: pnpm reports an unmet peer as the dependency
 * *path* that reached it, so every package along the way is named whichever one
 * actually declared the peer. Searching it for a package name answers "was this
 * package in the tree", not "did this package refuse" — the only way to make it
 * mean the second is to install that package where nothing else could have been
 * the refuser.
 */
export function installConsumer({ dependencies, overrides }) {
  const directory = mkdtempSync(join(tmpdir(), "nothrow-peer-"));

  const manifest = {
    name: "nothrow-peer-gate-consumer",
    version: "0.0.0",
    private: true,
    dependencies,
    ...(overrides === undefined ? {} : { pnpm: { overrides } }),
  };
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  // Both settings are pnpm 9 defaults, written down so a runner configured
  // otherwise cannot quietly turn a refusal into a warning, or a conflict into a
  // missing peer. Auto-installing the peers we did not name is what keeps a
  // consumer manifest to the one dependency the gate is actually about.
  writeFileSync(
    join(directory, ".npmrc"),
    "strict-peer-dependencies=true\nauto-install-peers=true\n",
  );

  try {
    pnpm(["install", "--ignore-scripts"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { refused: false, output: "" };
  } catch (error) {
    return {
      refused: true,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

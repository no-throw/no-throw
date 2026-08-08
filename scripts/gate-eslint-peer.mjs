// The defect a narrow `eslint` peer range causes is an install-time one: a
// consumer on an excluded major gets an unmet-peer warning, or an outright
// failure under `strict-peer-dependencies=true`. Running the suite on that
// major answers a different question and cannot catch it — the matrix resolves
// its ESLint through a pnpm override, and an override rewrites peer ranges, so
// no conflict survives to be reported.
//
// So this installs what would be published, the way a consumer installs it,
// once per claimed major.
//
//   node scripts/gate-eslint-peer.mjs
//   node scripts/gate-eslint-peer.mjs --self-check
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { declaredMajors } from "./eslint-peer-range.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// On Windows `pnpm` may be a `.cmd`, which Node refuses to spawn without a
// shell, and a shell wants its arguments quoted — the temp directories below can
// sit under a path with a space in it.
function pnpm(args, options) {
  return process.platform === "win32"
    ? execFileSync("pnpm", args.map((argument) => `"${argument}"`), {
        ...options,
        shell: true,
      })
    : execFileSync("pnpm", args, options);
}

function pack(packageDirectory, destination) {
  const output = pnpm(["pack", "--pack-destination", destination], {
    cwd: join(repoRoot, packageDirectory),
    encoding: "utf8",
  });
  return output.trim().split("\n").at(-1).trim();
}

function install(major, tarballs) {
  const directory = mkdtempSync(join(tmpdir(), "nothrow-peer-"));

  // `@no-throw/core` is a sibling at a version no registry has yet, so the
  // consumer has to be told where it is. Overriding it leaves the `eslint` peer
  // this gate is about resolved the way a real install would resolve it.
  const manifest = {
    name: "nothrow-peer-gate-consumer",
    version: "0.0.0",
    private: true,
    dependencies: {
      "@no-throw/eslint-plugin": `file:${tarballs.plugin}`,
      "@typescript-eslint/eslint-plugin": "^8.18.0",
      eslint: `^${major}.0.0`,
      typescript: "^5.7.2",
    },
    pnpm: { overrides: { "@no-throw/core": `file:${tarballs.core}` } },
  };
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(join(directory, ".npmrc"), "strict-peer-dependencies=true\n");

  try {
    pnpm(["install", "--ignore-scripts"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { refused: false, output: "" };
  } catch (error) {
    return { refused: true, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function run() {
  const majors = declaredMajors().map((leg) => leg.major);
  const workspace = mkdtempSync(join(tmpdir(), "nothrow-peer-tarballs-"));

  try {
    const tarballs = {
      core: pack("packages/core", workspace),
      plugin: pack("packages/eslint-plugin", workspace),
    };

    if (!process.argv.includes("--self-check")) {
      for (const major of majors) {
        const { refused, output } = install(major, tarballs);
        if (refused) {
          throw new Error(
            `The plugin claims ESLint ${major}, and a consumer installing it on ESLint ${major} was refused:\n${output}`,
          );
        }
        console.log(`ESLint ${major}: installs clean under strict peers.`);
      }
      return;
    }

    // A gate that cannot fail is not a gate: the major below the range is one
    // the claim excludes, so a consumer on it must be refused, and refused over
    // *our* peer rather than something incidental.
    const excluded = Math.min(...majors) - 1;
    if (excluded < 1) {
      throw new Error(
        `The peer range starts at ESLint ${Math.min(...majors)}, so there is no earlier major to be refused on. Name an excluded version by hand.`,
      );
    }

    const { refused, output } = install(excluded, tarballs);
    if (!refused) {
      throw new Error(
        `ESLint ${excluded} is outside the declared range and a consumer installed on it anyway: this gate cannot fail.`,
      );
    }
    if (!output.includes("@no-throw/eslint-plugin")) {
      throw new Error(
        `ESLint ${excluded} was refused, but not over our peer, so the gate would pass for the wrong reason:\n${output}`,
      );
    }

    console.log(
      `Self-check OK: a consumer on the excluded ESLint ${excluded} is refused over the plugin's own peer.`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

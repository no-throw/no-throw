// What a consumer downloads, checked before anything is published. A `files`
// list that forgot the baseline data produces a package that installs cleanly
// and floors every builtin — a defect no test in this repo can see, because
// every one of them resolves the workspace directory rather than a tarball.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * What each package has to carry, beyond what npm includes on its own. Paths
 * are as they appear inside the tarball, without the `package/` prefix npm
 * wraps everything in.
 */
const REQUIRED = {
  "@no-throw/core": [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/baseline/index.js",
    // The two the engine reads at runtime, and the reason this script exists.
    "baseline-data/es.json",
    "baseline-data/dom.json",
    "schema/nothrow.schema.json",
    "schema/nothrow.overrides.schema.json",
    "LICENSE",
    "README.md",
  ],
  "@no-throw/eslint-plugin": [
    "dist/index.js",
    "dist/index.d.ts",
    "LICENSE",
    "README.md",
  ],
  "@no-throw/cli": ["dist/bin.js", "LICENSE", "README.md"],
};

const BLOCK = 512;

const problems = [];

for (const [name, required] of Object.entries(REQUIRED)) {
  const packed = packedFiles(name);

  for (const path of required) {
    if (!packed.has(path)) problems.push(`${name}: ${path} is not in the tarball`);
  }

  // A package that ships its own sources doubles its install size and invites
  // a consumer to import past the entry points.
  for (const path of packed) {
    if (path.startsWith("src/") || path.endsWith(".tsbuildinfo")) {
      problems.push(`${name}: ${path} should not be in the tarball`);
    }
  }
}

// The two adapters name core as a dependency, and pnpm rewrites `workspace:*`
// as it packs. A tarball that still says `workspace:*` installs nowhere.
for (const name of ["@no-throw/eslint-plugin", "@no-throw/cli"]) {
  const manifest = JSON.parse(
    readFileSync(join(root, "packages", directoryOf(name), "package.json"), "utf8"),
  );
  const range = manifest.dependencies?.["@no-throw/core"];
  if (range !== "workspace:*") {
    problems.push(
      `${name}: depends on @no-throw/core as "${range}" — the workspace protocol is what the packer rewrites`,
    );
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(
  `Packed OK: ${Object.keys(REQUIRED).length} tarballs carry what they claim.`,
);

/**
 * What is really inside the tarball. `pnpm pack` has no dry run that lists
 * entries, and the point of the check is the artifact rather than the `files`
 * field it was derived from — so the tarball is built and read.
 */
function packedFiles(name) {
  const destination = mkdtempSync(join(tmpdir(), "nothrow-pack-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: join(root, "packages", directoryOf(name)),
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    const [tarball] = readdirSync(destination);
    const entries = tarEntries(gunzipSync(readFileSync(join(destination, tarball))));
    // npm wraps everything in a `package/` directory nobody names in `files`.
    return new Set(
      entries
        .filter((path) => path.startsWith("package/"))
        .map((path) => path.slice("package/".length)),
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

/**
 * The paths in an uncompressed tar. Only names are wanted, so this reads
 * headers and skips payloads: `name`, joined to the `prefix` a long path is
 * split across, and the `size` that says how far the next header is.
 */
function tarEntries(tar) {
  const paths = [];

  for (let at = 0; at + BLOCK <= tar.length; ) {
    const header = tar.subarray(at, at + BLOCK);
    const name = field(header, 0, 100);
    // Two zeroed blocks end the archive, and a zeroed name is the first of them.
    if (name === "") break;

    const size = Number.parseInt(field(header, 124, 12) || "0", 8);
    const typeFlag = String.fromCharCode(header[156]);
    const prefix = field(header, 345, 155);

    // `x`/`g` are pax metadata and `L` a GNU long name: each describes the
    // entry after it rather than being one, so only its payload is skipped.
    if (!["x", "g", "L"].includes(typeFlag)) {
      paths.push(prefix === "" ? name : `${prefix}/${name}`);
    }

    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }

  return paths;
}

function field(header, offset, length) {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8").trim();
}

function directoryOf(name) {
  return name.slice("@no-throw/".length);
}

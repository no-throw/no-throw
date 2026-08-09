// The one place a version is written. `check-lockstep.mjs` makes a mismatch a
// build failure; this makes producing one take a deliberate edit, because the
// only supported way to move a version is to move all of them at once.
//
//   node scripts/release.mjs 1.0.0
//
// It writes and nothing else. Building, the gates, the tag and the publish are
// the release workflow's, so that what ships is what CI just proved, rather
// than what a working tree happened to hold.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const [version] = process.argv.slice(2);
if (version === undefined) {
  fail("usage: node scripts/release.mjs <version>");
}

// Deliberately narrower than semver: a prerelease or a build tag would ship
// under a `latest` dist-tag this pipeline has no way to override, and the three
// packages moving in lockstep is the one thing a version means here.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`\`${version}\` is not a release version — expected \`major.minor.patch\``);
}

const packagesDir = join(root, "packages");
const manifests = [
  join(root, "package.json"),
  ...readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, "package.json")),
];

const read = manifests.map((path) => ({
  path,
  json: JSON.parse(readFileSync(path, "utf8")),
}));

// Read every manifest before writing any. A bump that half-succeeded would
// leave the tree in the state this script exists to prevent.
const current = new Set(read.map(({ json }) => json.version));
if (current.size > 1) {
  fail(
    `Refusing to bump: the manifests are already out of lockstep at ${[...current].sort().join(", ")}.`,
  );
}

for (const { path, json } of read) {
  json.version = version;
  // Rewriting the parsed object reorders nothing: `version` is already there,
  // so the key keeps its place and the diff is one line per manifest.
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

console.log(
  `Release ${version}: ${manifests.length} manifests written (was ${[...current][0]}).`,
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

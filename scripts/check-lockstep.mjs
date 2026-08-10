// The published packages are versioned in lockstep. This makes that a build
// failure rather than a convention, and pins internal deps to `workspace:*` so
// a release cannot ship a package against a stale sibling.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packagesDir = join(root, "packages");

const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDir, entry.name));

const manifests = packageDirs.map((directory) => {
  const path = join(directory, "package.json");
  return { path, json: JSON.parse(readFileSync(path, "utf8")) };
});

const problems = [];

// npm reaches no further than the package directory, so a published package
// carrying an MIT `license` field and no text is a claim with nothing behind
// it. The copies are the only way to ship one; this is what keeps them from
// becoming three different licenses.
const license = readFileSync(join(root, "LICENSE"), "utf8");
for (const directory of packageDirs) {
  const path = join(directory, "LICENSE");
  let shipped;
  try {
    shipped = readFileSync(path, "utf8");
  } catch {
    problems.push(`${path}: missing — copy the root LICENSE here`);
    continue;
  }
  if (shipped !== license) {
    problems.push(`${path}: differs from the root LICENSE`);
  }
}

const versions = new Set(manifests.map(({ json }) => json.version));
if (versions.size > 1) {
  const listed = manifests
    .map(({ json }) => `  ${json.name} ${json.version}`)
    .join("\n");
  problems.push(`Packages are not in lockstep:\n${listed}`);
}

const internal = new Set(manifests.map(({ json }) => json.name));
for (const { path, json } of manifests) {
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries(json[field] ?? {})) {
      if (!internal.has(name)) continue;
      if (range !== "workspace:*") {
        problems.push(
          `${path}: ${field}.${name} is "${range}", expected "workspace:*"`,
        );
      }
    }
  }
}

// A peer range is a claim, and a consumer installing two of these packages gets
// the intersection of what they claim. Two packages naming the same peer
// differently makes that intersection the real contract while neither manifest
// states it. The `typescript` gate refuses to read a range its packages disagree
// about, but that is one peer and it costs a network install to find out; this
// is every shared peer, in `pnpm test`, before anything is fetched.
const peerRanges = new Map();
for (const { json } of manifests) {
  for (const [name, range] of Object.entries(json.peerDependencies ?? {})) {
    if (internal.has(name)) continue;
    if (!peerRanges.has(name)) peerRanges.set(name, new Map());
    peerRanges.get(name).set(json.name, range);
  }
}

for (const [name, byPackage] of peerRanges) {
  if (new Set(byPackage.values()).size === 1) continue;
  const listed = [...byPackage]
    .map(([packageName, range]) => `  ${packageName}: "${range}"`)
    .join("\n");
  problems.push(
    `The packages disagree about the \`${name}\` peer range:\n${listed}`,
  );
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(
  `Lockstep OK: ${manifests.length} packages at ${[...versions][0]}.`,
);

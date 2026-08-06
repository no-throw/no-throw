// The three published packages are versioned in lockstep (spec #30 §A). This
// makes that a build failure rather than a convention, and pins internal deps
// to `workspace:*` so a release cannot ship a package against a stale sibling.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = fileURLToPath(new URL("../packages/", import.meta.url));

const manifests = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const path = join(packagesDir, entry.name, "package.json");
    return { path, json: JSON.parse(readFileSync(path, "utf8")) };
  });

const problems = [];

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

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(
  `Lockstep OK: ${manifests.length} packages at ${[...versions][0]}.`,
);

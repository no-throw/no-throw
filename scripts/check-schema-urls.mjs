// A `$id` is a promise about where the document lives, and every validator
// that resolves a `$ref` across files takes it literally — the overrides schema
// points at the manifest schema by absolute URL, so an `$id` that does not
// match the deployed path turns editor validation into a fetch of nothing.
//
// Run over the laid-out site directory, before it is deployed:
//
//   node scripts/check-schema-urls.mjs site
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * Where Pages serves this repo. A project site is `<org>.github.io/<repo>/`,
 * and the org is `no-throw` (#20) as is the repo (#75) — so the base is the
 * name twice, which reads like a mistake and is not.
 */
const BASE = "https://no-throw.github.io/no-throw/";

const [site] = process.argv.slice(2);
if (site === undefined) {
  console.error("usage: node scripts/check-schema-urls.mjs <site-directory>");
  process.exit(1);
}

const problems = [];
const served = new Set();

for (const path of schemaFiles(join(root, site))) {
  const url = new URL(relative(join(root, site), path).split(sep).join("/"), BASE)
    .href;
  served.add(url);

  const json = JSON.parse(readFileSync(path, "utf8"));
  // The unversioned copies are aliases of the current major, so their `$id`
  // is the versioned URL on purpose: one document, one identity, whichever
  // path it was fetched through.
  if (!url.includes("/schema/v")) continue;
  if (json.$id !== url) {
    problems.push(`${url}: served here, but its \`$id\` says ${json.$id}`);
  }
}

// Every absolute `$ref` into our own space has to land on something deployed.
for (const path of schemaFiles(join(root, site))) {
  const source = readFileSync(path, "utf8");
  for (const [, ref] of source.matchAll(/"\$ref":\s*"(https:[^"#]+)[^"]*"/gu)) {
    if (!ref.startsWith(BASE)) continue;
    if (!served.has(ref)) problems.push(`${path}: \`$ref\` to ${ref}, which is not deployed`);
  }
}

if (served.size === 0) problems.push(`${site}: no schemas laid out`);

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`Schema URLs OK: ${served.size} documents served where they say they are.`);

function schemaFiles(directory) {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

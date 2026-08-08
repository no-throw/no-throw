import { existsSync } from "node:fs";
import {
  readColorDocument,
  type ColorTable,
  type ColorTables,
  type TablePath,
} from "./document.js";
import { isRecord, join, type PackageHome } from "./packages.js";
import { manifestSchema, overridesSchema } from "./schemas.js";

const EMPTY: ColorTables = new Map();

/** One table per package, at `packages` → the package → `exports`. */
const TABLES: TablePath = ["packages", "*", "exports"];

const projects = new Map<string, ColorTables>();

/**
 * What a project asserts for itself, by npm package name.
 *
 * `nothrow.overrides.json` is the top of the chain and the one rung nobody else
 * has to act for you: a dependency ships the wrong colors, or none, and you
 * write them down rather than waiting on a release. That is why it outranks
 * even an overlay, and why the floor diagnostic names it first.
 *
 * "Project root" is the same walk-up every other file in this design is found
 * by: the first `package.json` above the file being analyzed, consulted alone.
 * Nothing merges across a package boundary here either — a workspace package
 * asserting something for itself is not asserting it for its siblings.
 */
export function overridesIn(asking: PackageHome | undefined): ColorTables {
  if (asking === undefined) return EMPTY;

  const known = projects.get(asking.directory);
  if (known !== undefined) return known;

  const found = readOverrides(asking);
  projects.set(asking.directory, found);
  return found;
}

function readOverrides(asking: PackageHome): ColorTables {
  const path = join(asking.directory, "nothrow.overrides.json");
  if (!existsSync(path)) return EMPTY;

  // The entry shape is the manifest's, borrowed by `$ref` rather than copied,
  // so the two files cannot drift into disagreeing about what an entry is.
  const document = readColorDocument(
    path,
    overridesSchema(),
    [manifestSchema()],
    TABLES,
  );
  // A version this release cannot read leaves the rungs below to answer. An
  // override replaces the chain's answer rather than supplying a fact with a
  // strict default, so there is no safe reading of one to fall back on — and
  // unlike a package's own manifest, nothing here supersedes a tag that was
  // written for the same future reading.
  if (document.kind !== "read") return EMPTY;

  const packages = document.value["packages"];
  if (!isRecord(packages)) return EMPTY;

  const tables = new Map<string, ColorTable>();
  for (const name of Object.keys(packages)) {
    tables.set(name, document.tableAt([name]));
  }
  return tables;
}

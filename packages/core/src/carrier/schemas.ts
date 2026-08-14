import { readFileSync } from "node:fs";

/**
 * The schemas this package publishes, which are also the ones its readers
 * enforce. Shipping one file for both is what keeps the contract hand-authors
 * validate against from drifting away from the contract the engine applies —
 * and the overrides file borrows the manifest's entry definitions by `$ref`
 * rather than restating them, for the same reason.
 */

const loaded = new Map<string, unknown>();

function load(file: URL): unknown {
  const known = loaded.get(file.href);
  if (known !== undefined) return known;
  const schema: unknown = JSON.parse(readFileSync(file, "utf8"));
  loaded.set(file.href, schema);
  return schema;
}

/**
 * What each schema is called, which is also how a report points an author at
 * it. Named here rather than at the report, so the file a reader is sent to
 * open is the file the reader actually evaluated.
 */
export const MANIFEST_SCHEMA = "nothrow.schema.json";
export const OVERRIDES_SCHEMA = "nothrow.overrides.schema.json";

/** `nothrow.json`: what a package ships, and what an overlay publishes. */
export function manifestSchema(): unknown {
  return load(new URL(`../../schema/${MANIFEST_SCHEMA}`, import.meta.url));
}

/** `nothrow.overrides.json`: what a project asserts for itself. */
export function overridesSchema(): unknown {
  return load(new URL(`../../schema/${OVERRIDES_SCHEMA}`, import.meta.url));
}

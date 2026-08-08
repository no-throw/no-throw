import type { AccessorFact, Color, ConditionPath } from "../baseline/types.js";
import { isRecord, readJson } from "./packages.js";
import { validate, type SchemaIssue } from "./schema.js";

/**
 * One symbol's colors on the wire. The same four facts the baseline carries,
 * with the same fail-safe reading of absence, so every rung of the resolver
 * chain composes the same way.
 */
export interface ManifestEntry {
  readonly color?: Color;
  readonly async?: boolean;
  readonly conditions?: readonly ConditionPath[];
  readonly accessor?: AccessorFact;
}

/**
 * An entry, or the fact that one was written and cannot be used. The second is
 * not the same as no entry at all: a key a carrier claims and this reader
 * cannot honor floors rather than falling through to a rung that knows less
 * about it.
 */
export type EntryState =
  | { readonly kind: "entry"; readonly entry: ManifestEntry }
  | { readonly kind: "unusable" };

/** One `exports` table — subpath, then symbol path — as something to ask. */
export interface ColorTable {
  entryFor(subpath: string, key: string): EntryState | undefined;
}

/** Tables by the npm package each one colors, which is how a rung holds them. */
export type ColorTables = ReadonlyMap<string, ColorTable>;

/**
 * A colors document, read and validated. The three states are the ones every
 * carrier file shares: it says nothing, it says something, or it says its facts
 * need a reader this release does not have. What each caller *does* with
 * "unreadable" differs, so the reading stops here and the rungs decide.
 */
export type ColorDocument =
  | {
      readonly kind: "read";
      readonly value: Record<string, unknown>;
      /**
       * One table, named by filling in the wildcards of the document's
       * `TablePath` — nothing for a manifest, the package name for the
       * overrides file.
       */
      readonly tableAt: (names: readonly string[]) => ColorTable;
    }
  | { readonly kind: "unreadable" }
  | { readonly kind: "absent" };

const ABSENT: ColorDocument = { kind: "absent" };

/** The wire version this release understands. */
const VERSION = 1;

/**
 * Where a document's entry tables live, as a property path with `*` standing
 * for any one segment: `exports` in a manifest, `packages/<name>/exports` in
 * the overrides file. Everything that follows from the shape follows from this
 * one statement of it — which faults fall inside an entry rather than in the
 * envelope around them, and which entry each one falls in — so there is no
 * second statement to keep in step.
 */
export type TablePath = readonly string[];

/** The one segment of a `TablePath` a caller fills in. */
const ANY = "*";

/**
 * Read a colors file: parse it, hold it to the schema it publishes, and index
 * what survives. Unreadable and malformed are the same thing to every reader
 * here — the file says nothing, so nothing is taken from it.
 */
export function readColorDocument(
  path: string,
  schema: unknown,
  imported: readonly unknown[],
  location: TablePath,
): ColorDocument {
  const value = readJson(path);
  if (value === undefined) return ABSENT;

  const issues = validate(schema, value, imported);
  // A fault inside an entry floors that entry; anything shallower is a file
  // that does not describe what it claims to, and nothing is taken from it.
  if (issues.some((issue) => !isEntryFault(issue.path, location))) {
    return ABSENT;
  }

  if (value["version"] !== VERSION) return { kind: "unreadable" };

  const tables = new Map<string, ColorTable>();

  return {
    kind: "read",
    value,
    tableAt: (names) => {
      const prefix = fill(location, names);
      const at = identityOf(prefix);
      const known = tables.get(at);
      if (known !== undefined) return known;
      const table = indexTable(value, prefix, issues);
      tables.set(at, table);
      return table;
    },
  };
}

/** An entry is a subpath and a key past its table, and its faults are past it. */
function isEntryFault(path: readonly string[], location: TablePath): boolean {
  return (
    path.length > location.length + 2 &&
    location.every(
      (segment, index) => segment === ANY || path[index] === segment,
    )
  );
}

function fill(location: TablePath, names: readonly string[]): readonly string[] {
  let next = 0;
  return location.map((segment) =>
    segment === ANY ? (names[next++] ?? ANY) : segment,
  );
}

function indexTable(
  value: Record<string, unknown>,
  prefix: readonly string[],
  issues: readonly SchemaIssue[],
): ColorTable {
  const unusable = new Set(
    issues
      .filter((issue) => startsWith(issue.path, prefix))
      .map((issue) =>
        identityOf(issue.path.slice(prefix.length, prefix.length + 2)),
      ),
  );
  const table = valueAt(value, prefix);

  return {
    entryFor: (subpath, key) => {
      if (unusable.has(identityOf([subpath, key]))) return { kind: "unusable" };
      const entries = isRecord(table) ? table[subpath] : undefined;
      const entry = isRecord(entries) ? entries[key] : undefined;
      return isRecord(entry)
        ? { kind: "entry", entry: entry as ManifestEntry }
        : undefined;
    },
  };
}

function valueAt(
  value: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function startsWith(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    path.length >= prefix.length &&
    prefix.every((segment, index) => path[index] === segment)
  );
}

/**
 * A path, as an identity. Encoded rather than joined: an npm package name and
 * an export subpath follow npm's grammar and a symbol path follows JSDoc's, and
 * any separator one of them could hold would merge two entries and floor the
 * wrong one.
 */
function identityOf(path: readonly string[]): string {
  return JSON.stringify(path);
}

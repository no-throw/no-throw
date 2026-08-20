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
  /**
   * `faults` names where inside the entry the schema rejected it, as the
   * property paths past the entry an author would point at. A resolver has no
   * use for them — the entry floors whatever it was going to say — but the
   * reader checking a carrier does: the file is the only place a fix can be
   * made, and an entry discarded without saying which field lost it is the
   * silent no-op again, one level down.
   */
  | { readonly kind: "unusable"; readonly faults: readonly string[] };

/**
 * One entry's address inside a table: the surface it is reached through, then
 * the namepath into that surface.
 *
 * The first half is an npm export subpath in a `packages` table and an ambient
 * module specifier in a `modules` one. Which of the two it is, is a fact about
 * the table it was found in — the caller's half of the address — and nothing
 * here needs to know it: the two halves are read and matched the same way
 * either way, and a table that named them after one of its two callers would
 * be lying to the other.
 */
export interface TableKey {
  readonly through: string;
  readonly symbolPath: string;
}

/** One entry, at the key the file wrote it under. */
export interface WrittenEntry extends TableKey {
  readonly state: EntryState;
}

/** One entry table — a surface, then a symbol path — as something to ask. */
export interface ColorTable {
  entryFor(key: TableKey): EntryState | undefined;
  /**
   * Every entry written under this table, in the order the file wrote them.
   * A resolver asks by key and never needs this; a reader reporting on the
   * file has no key to ask by — the entries *are* the question — and walking
   * the document for them would be a second statement of the shape `TablePath`
   * exists to state once, one that could not see the entries this reader
   * discarded.
   */
  written(): readonly WrittenEntry[];
}

/** Tables by the npm package each one colors, which is how a rung holds them. */
export type ColorTables = ReadonlyMap<string, ColorTable>;

/**
 * The `modules` tables a rung holds, in the order it consults them. A list
 * rather than a map, because one table already answers for every specifier it
 * names: there is no package to file it under, which is the whole point of it.
 */
export type ModuleTables = readonly ColorTable[];

/** What one rung of the chain has to look a declaration up in. */
export interface CarrierTables {
  /** Keyed by npm package, then export subpath, then namepath. */
  readonly packages: ColorTables;
  /** Keyed by ambient module specifier, then namepath. */
  readonly modules: ModuleTables;
}

export const NO_TABLES: CarrierTables = { packages: new Map(), modules: [] };

/**
 * Why a file that was there came to nothing. Which of the two happened is the
 * one thing a reader cannot recover from the outcome, and "the file is there
 * and is being ignored" is what every carrier owes its author.
 */
export type DocumentRefusal =
  /** Unreadable, unparseable, or parsing to something that is not an object. */
  | { readonly kind: "not-an-object" }
  /** Where the envelope departs from the schema. */
  | { readonly kind: "invalid"; readonly issues: readonly SchemaIssue[] };

/**
 * A colors document, read and validated. The three states are the ones every
 * carrier file shares: it says something, it says its facts need a reader this
 * release does not have, or it does not describe what it claims to. What each
 * caller *does* with the last two differs, so the reading stops here and the
 * rungs decide.
 *
 * There is no state for a file that is not there: every caller looks first, and
 * a document nobody wrote is not a document that came to nothing.
 */
export type ColorDocument =
  | {
      readonly kind: "read";
      readonly value: Record<string, unknown>;
      /**
       * One table, named by filling in the wildcards of one of the document's
       * `TablePath`s — nothing for a manifest's `exports` or a `modules` table,
       * the package name for the overrides file's.
       */
      readonly tableAt: (
        location: TablePath,
        names: readonly string[],
      ) => ColorTable;
    }
  | { readonly kind: "unreadable"; readonly version: unknown }
  | { readonly kind: "refused"; readonly refusal: DocumentRefusal };

/** The wire version this release understands. */
const VERSION = 1;

/**
 * Where a document's entry tables live, as a property path with `*` standing
 * for any one segment: `exports` in a manifest, `packages/<name>/exports` in
 * the overrides file, `modules` in both. Everything that follows from the shape
 * follows from this one statement of it — which faults fall inside an entry
 * rather than in the envelope around them, and which entry each one falls in —
 * so there is no second statement to keep in step.
 *
 * A file may hold tables at several of them, and a `TableKey` is always the
 * last two segments of the path to an entry, whichever table it is in.
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
  locations: readonly TablePath[],
): ColorDocument {
  const value = readJson(path);
  if (value === undefined) {
    return { kind: "refused", refusal: { kind: "not-an-object" } };
  }

  const issues = validate(schema, value, imported);
  // A fault inside an entry floors that entry; anything shallower is a file
  // that does not describe what it claims to, and nothing is taken from it.
  const envelope = issues.filter(
    (issue) =>
      !locations.some((location) => isEntryFault(issue.path, location)),
  );
  if (envelope.length > 0) {
    return { kind: "refused", refusal: { kind: "invalid", issues: envelope } };
  }

  if (value["version"] !== VERSION) {
    return { kind: "unreadable", version: value["version"] };
  }

  const tables = new Map<string, ColorTable>();

  return {
    kind: "read",
    value,
    tableAt: (location, names) => {
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

/** An entry is a `TableKey` past its table, and its own faults are past it. */
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
  const unusable = new Map<string, Set<string>>();
  for (const issue of issues) {
    if (!startsWith(issue.path, prefix)) continue;
    const at = identityOf(issue.path.slice(prefix.length, prefix.length + 2));
    const faults = unusable.get(at) ?? new Set<string>();
    // Deduped, because one value can depart from a schema more than once — a
    // `oneOf` reports the branch and the whole — and a field named twice reads
    // as two faults to fix.
    faults.add(issue.path.slice(prefix.length + 2).join("."));
    unusable.set(at, faults);
  }
  const table = valueAt(value, prefix);

  const entryFor = (key: TableKey): EntryState | undefined => {
    const faults = unusable.get(identityOf([key.through, key.symbolPath]));
    if (faults !== undefined) return { kind: "unusable", faults: [...faults] };
    const entries = isRecord(table) ? table[key.through] : undefined;
    const entry = isRecord(entries) ? entries[key.symbolPath] : undefined;
    return isRecord(entry)
      ? { kind: "entry", entry: entry as ManifestEntry }
      : undefined;
  };

  return {
    entryFor,
    written: () => {
      if (!isRecord(table)) return [];
      const written: WrittenEntry[] = [];
      for (const [through, keys] of Object.entries(table)) {
        if (!isRecord(keys)) continue;
        for (const symbolPath of Object.keys(keys)) {
          const state = entryFor({ through, symbolPath });
          if (state !== undefined) written.push({ through, symbolPath, state });
        }
      }
      return written;
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

import { existsSync } from "node:fs";
import {
  NO_TABLES,
  readColorDocument,
  type CarrierTables,
  type ColorTable,
  type DocumentRefusal,
  type TablePath,
} from "./document.js";
import { isRecord, type PackageHome } from "./packages.js";
import type { SchemaIssue } from "./schema.js";
import {
  manifestSchema,
  overridesSchema,
  OVERRIDES_SCHEMA_FILE,
} from "./schemas.js";

/** The name the file has, everywhere, by convention rather than by lookup. */
export const OVERRIDES = "nothrow.overrides.json";

/** One table per package, at `packages` → the package → `exports`. */
const PACKAGES: TablePath = ["packages", "*", "exports"];

/** One table for every ambient module the file colors, at `modules`. */
export const MODULES: TablePath = ["modules"];

/**
 * A carrier file the project wrote for itself and this release cannot honor.
 *
 * Every other rung answers for somebody else's package, and the sound thing to
 * do with one it cannot read is to fall through to the rung below. The
 * overrides file is the project's own, so falling through means silently
 * discarding what its author wrote — the no-op `valid-mark` exists one rung up
 * to prevent. Nothing is analyzed until it is fixed or removed.
 */
export class OverridesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverridesError";
  }
}

/**
 * What the project's `nothrow.overrides.json` amounts to. The four states are
 * kept apart because each is owed a different answer: absent says nothing and
 * means nothing, refused stops the run, a version this release cannot read
 * leaves the rungs below to answer, and a read file colors.
 */
export type OverridesState =
  /** Where one would have been found, so a report can say where it looked. */
  | { readonly kind: "absent"; readonly path: string }
  | {
      readonly kind: "refused";
      readonly path: string;
      readonly refusal: DocumentRefusal;
    }
  | {
      readonly kind: "unknown-version";
      readonly path: string;
      readonly version: unknown;
    }
  | {
      readonly kind: "read";
      readonly path: string;
      /**
       * One table per package named, in the order they were written, and one
       * for the ambient modules the file colors.
       */
      readonly tables: CarrierTables;
    };

const projects = new Map<string, OverridesState>();

/**
 * What a project asserts for itself, by npm package name and by ambient module
 * specifier.
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
 *
 * A file this release cannot honor throws rather than answering: see
 * `OverridesError`.
 */
export function overridesIn(asking: PackageHome | undefined): CarrierTables {
  const state = overridesStateIn(asking);
  if (state.kind === "refused") {
    // The path trails the sentence rather than opening it: what is wrong does
    // not vary by machine, and a host that already names the file — the CLI's
    // report does — has the sentence alone.
    throw new OverridesError(`${refusalMessage(state)}: ${state.path}`);
  }
  return state.kind === "read" ? state.tables : NO_TABLES;
}

/**
 * The same file, as something to report on rather than to resolve against.
 * `nothrow check` needs the states `overridesIn` collapses — including the one
 * it refuses on, which it has to describe rather than raise.
 */
export function overridesStateIn(
  asking: PackageHome | undefined,
): OverridesState {
  if (asking === undefined) return { kind: "absent", path: OVERRIDES };

  const known = projects.get(asking.directory);
  if (known !== undefined) return known;

  const found = readOverrides(asking);
  projects.set(asking.directory, found);
  return found;
}

/** What a refusal reads as, in the one channel that survives into CI. */
export function refusalMessage(
  state: Extract<OverridesState, { kind: "refused" }>,
): string {
  const why =
    state.refusal.kind === "not-an-object"
      ? "it could not be read as a JSON object"
      : `it does not validate against \`${OVERRIDES_SCHEMA_FILE}\` at ${faultsAt(state.refusal.issues)}`;

  return (
    `\`${OVERRIDES}\` cannot be read — ${why} — so nothing in it ` +
    "is being honored. An overrides file that is quietly ignored is the " +
    "silent no-op the rest of this design exists to rule out, so nothing is " +
    "analyzed until it is fixed or removed"
  );
}

/** Where the envelope departs from the schema, as an author would point. */
function faultsAt(issues: readonly SchemaIssue[]): string {
  const named = issues.map((issue) =>
    issue.path.length === 0
      ? "the document itself"
      : `\`${issue.path.join(".")}\``,
  );
  return [...new Set(named)].join(", ");
}

function readOverrides(asking: PackageHome): OverridesState {
  // Joined by hand rather than resolved, because this string is read *and*
  // printed: the walk-up already spells a directory one way, and resolving
  // would hand a reader a path spelled the platform's way instead.
  const path = `${asking.directory}/${OVERRIDES}`;
  if (!existsSync(path)) return { kind: "absent", path };

  // The entry shape is the manifest's, borrowed by `$ref` rather than copied,
  // so the two files cannot drift into disagreeing about what an entry is.
  const document = readColorDocument(
    path,
    overridesSchema(),
    [manifestSchema()],
    [PACKAGES, MODULES],
  );

  // A version this release cannot read leaves the rungs below to answer. An
  // override replaces the chain's answer rather than supplying a fact with a
  // strict default, so there is no safe reading of one to fall back on — and
  // unlike a package's own manifest, nothing here supersedes a tag that was
  // written for the same future reading. It is not refused: reading forward is
  // what the version field is for, and a file from the future is not a broken
  // one.
  if (document.kind === "unreadable") {
    return { kind: "unknown-version", path, version: document.version };
  }
  if (document.kind === "refused") {
    return { kind: "refused", path, refusal: document.refusal };
  }

  const packaged = document.value["packages"];
  const moduled = document.value["modules"];

  // A file holding neither table asserts nothing, which is what an absent one
  // does. An empty table is not that: it was written, so the file is read and
  // reported as one that says nothing rather than as one that is not there.
  if (!isRecord(packaged) && !isRecord(moduled)) {
    return { kind: "absent", path };
  }

  const packages = isRecord(packaged) ? Object.keys(packaged) : [];
  const modules = isRecord(moduled) ? Object.keys(moduled) : [];

  const byPackage = new Map<string, ColorTable>();
  for (const name of packages) {
    byPackage.set(name, document.tableAt(PACKAGES, [name]));
  }
  return {
    kind: "read",
    path,
    tables: {
      packages: byPackage,
      modules: modules.length === 0 ? [] : [document.tableAt(MODULES, [])],
    },
  };
}

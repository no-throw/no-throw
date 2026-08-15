import { dirname } from "node:path";
import ts from "typescript";
import type { ColorTable } from "./carrier/document.js";
import { installedOverlaysFor } from "./carrier/overlays.js";
import {
  OVERRIDES,
  overridesStateIn,
  refusalMessage,
  type OverridesState,
} from "./carrier/overrides.js";
import { packageHomeOf, type PackageHome } from "./carrier/packages.js";
import {
  MANIFEST_SCHEMA_FILE,
  OVERRIDES_SCHEMA_FILE,
} from "./carrier/schemas.js";
import { exportSurfaceOf } from "./carrier/surface.js";

/** The three halves of a key, which is what a carrier writes an entry under. */
export interface EntryKey {
  /** The npm package the entry colors. */
  readonly package: string;
  readonly subpath: string;
  readonly symbolPath: string;
}

/**
 * What became of one entry. `reaches` is the whole point of the others
 * existing: an entry that colors nothing is indistinguishable from a correct
 * one at a call site, because both come to the same silence.
 */
export type CheckedEntry = EntryKey &
  (
    | { readonly verdict: "reaches" }
    /** Nothing of the package is in the program, so there is no surface. */
    | { readonly verdict: "unresolved" }
    /**
     * The entry is written and does not describe a color: the schema rejected
     * something inside it, so the reader discarded it before any question of
     * what it reaches. Asked first for that reason — a discarded entry keys as
     * well as a correct one, and the surface would call it healthy — and it is
     * asked of every entry, held package or not, because a file that departs
     * from its schema does so on every machine.
     *
     * `faults` names the fields that lost it, since the carrier file is the
     * only place the fix can be made. Which schema they lost against is the
     * carrier's, not the entry's.
     */
    | { readonly verdict: "unusable"; readonly faults: readonly string[] }
    /** The package publishes no such subpath; these are the ones it has. */
    | { readonly verdict: "no-subpath"; readonly subpaths: readonly string[] }
    /** The subpath is published and holds no such key; these are its keys. */
    | { readonly verdict: "no-key"; readonly published: readonly string[] }
    /**
     * The key resolves, and what it resolves to ships somewhere else. A rung
     * holds one table per package the *declaration* belongs to, so an entry
     * written under the package that re-exported it is never consulted.
     */
    | { readonly verdict: "ships-elsewhere"; readonly shipsIn: string }
    /**
     * The key resolves, and what it resolves to is declared where no
     * `package.json` names a package. A rung's table is matched by npm name, so
     * this one has no name to be keyed under at all — which is the difference
     * from `ships-elsewhere`, where there is a name and it is somebody else's.
     * `declaredIn` is the directory a `package.json` naming it would go in,
     * which is the walk's answer whether or not it found a file there.
     */
    | { readonly verdict: "unnamed-shipper"; readonly declaredIn: string }
  );

/**
 * Why nothing in a carrier was checked. A file that says nothing is not an
 * error; a file that was written and cannot be honored is, and `fatal` is that
 * difference.
 */
export interface CarrierProblem {
  readonly message: string;
  readonly fatal: boolean;
}

/** One carrier file, and what checking it came to. */
export interface CheckedCarrier {
  /** What the report calls it: the file's name, or an overlay's package. */
  readonly name: string;
  readonly path: string;
  /**
   * The published contract this file's entries were held to, as it is named on
   * disk. A property of the file rather than of any entry in it: the overrides
   * file and a manifest borrow one entry shape through two envelopes, and an
   * author sent to fix an entry is sent to the one their file declares.
   */
  readonly schema: string;
  readonly problem?: CarrierProblem;
  readonly entries: readonly CheckedEntry[];
}

export interface CheckOutcome {
  readonly carriers: readonly CheckedCarrier[];
}

/** Whether a verdict says the entry colors nothing. */
export function reachesNothing(entry: CheckedEntry): boolean {
  return entry.verdict !== "reaches" && entry.verdict !== "unresolved";
}

/**
 * Read every carrier this project wrote or installed, and say which of their
 * entries reach a symbol the packages they name actually publish.
 *
 * Nothing here resolves a color. The question is the one a call site can never
 * ask — *was this entry about anything?* — and it is asked the way the resolver
 * chain asks it: of the same export surface, and of the same package the chain
 * would hold a table for, which is the one the declaration ships in rather than
 * the one that re-exported it.
 *
 * Carriers are read per *asking* package, as the chain reads them: a workspace
 * package asserts for itself and not for its siblings, so a program spanning
 * several of them has several overrides files to check.
 */
export function checkCarriers(
  program: ts.Program,
  fallback: PackageHome | undefined,
): CheckOutcome {
  const packages = packagesIn(program);
  const carriers: CheckedCarrier[] = [];
  const seen = new Set<string>();

  for (const asking of askingHomes(program, fallback)) {
    for (const carrier of [
      overridesCarrier(overridesStateIn(asking), packages, program),
      ...overlayCarriers(asking, packages, program),
    ]) {
      if (seen.has(carrier.path)) continue;
      seen.add(carrier.path);
      carriers.push(carrier);
    }
  }

  return { carriers };
}

/**
 * The packages doing the asking: the ones the program's own files ship in, as
 * the chain determines them per file. The project the CLI was pointed at
 * answers for a program with no sources of its own to read them off.
 */
function askingHomes(
  program: ts.Program,
  fallback: PackageHome | undefined,
): readonly PackageHome[] {
  const homes = new Map<string, PackageHome>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const home = packageHomeOf(sourceFile.fileName);
    if (home !== undefined) homes.set(home.directory, home);
  }
  if (homes.size === 0 && fallback !== undefined) {
    homes.set(fallback.directory, fallback);
  }
  return [...homes.values()];
}

function overridesCarrier(
  state: OverridesState,
  packages: ReadonlyMap<string, PackageHome>,
  program: ts.Program,
): CheckedCarrier {
  const name = OVERRIDES;
  const schema = OVERRIDES_SCHEMA_FILE;

  switch (state.kind) {
    case "absent":
      return {
        name,
        path: state.path,
        schema,
        problem: {
          message: `there is no \`${name}\` here, so it asserts nothing.`,
          fatal: false,
        },
        entries: [],
      };
    case "refused":
      return {
        name,
        path: state.path,
        schema,
        problem: { message: refusalMessage(state), fatal: true },
        entries: [],
      };
    case "unknown-version":
      return {
        name,
        path: state.path,
        schema,
        // Reading forward is what the version field is for, so this is a fact
        // about the file rather than a fault in it — and it is exactly the
        // fact a reader cannot otherwise tell from the file being absent.
        problem: {
          message:
            `it names \`version\` ${JSON.stringify(state.version)}, and this ` +
            "release reads version 1, so none of it is being honored and the " +
            "rungs below it answer instead.",
          fatal: false,
        },
        entries: [],
      };
    case "read":
      return {
        name,
        path: state.path,
        schema,
        entries: [...state.tables].flatMap(([owner, table]) =>
          tableEntries(table, owner, packages, program),
        ),
      };
  }
}

function overlayCarriers(
  asking: PackageHome,
  packages: ReadonlyMap<string, PackageHome>,
  program: ts.Program,
): readonly CheckedCarrier[] {
  return installedOverlaysFor(asking).map(({ home: overlay, state }) => {
    const name = overlay.name ?? overlay.directory;
    const path = `${overlay.directory}/nothrow.json`;

    const schema = MANIFEST_SCHEMA_FILE;

    // A `@no-throw/*` package shipping no `nothrow.json` is not an overlay at
    // all, and the three this project ships are exactly that — so it is not
    // something to report, only something not to read.
    if (state.kind === "absent") return { name, path, schema, entries: [] };
    if (state.kind !== "valid") {
      return {
        name,
        path,
        schema,
        problem: overlayProblem(state.kind),
        entries: [],
      };
    }
    if (state.target === undefined) {
      return {
        name,
        path,
        schema,
        problem: {
          message:
            "it names no `package`, and an overlay is matched by that field " +
            "and by nothing else — never by the npm name it was published " +
            "under — so it colors nothing.",
          fatal: true,
        },
        entries: [],
      };
    }

    return {
      name,
      path,
      schema,
      entries: tableEntries(state.table, state.target, packages, program),
    };
  });
}

function overlayProblem(kind: "stale" | "unreadable"): CarrierProblem {
  return kind === "unreadable"
    ? {
        message:
          "it names a `version` this release cannot read, so none of it is " +
          "being honored.",
        fatal: false,
      }
    : {
        message:
          "its hashes no longer match the files it was written for, so none " +
          "of it is being honored.",
        fatal: true,
      };
}

/**
 * Every entry of one table, which is one package's colors. Read off the reader
 * rather than off the file, so that what is checked is what was read: an entry
 * the reader discarded is one the file wrote and no key will ever reach, and a
 * walk of the document could only see the first half of that.
 */
function tableEntries(
  table: ColorTable,
  packageName: string,
  packages: ReadonlyMap<string, PackageHome>,
  program: ts.Program,
): readonly CheckedEntry[] {
  return table.written().map(({ subpath, key: symbolPath, state }) => {
    const key = { package: packageName, subpath, symbolPath };
    return state.kind === "unusable"
      ? { ...key, verdict: "unusable" as const, faults: state.faults }
      : verdictFor(key, packages, program);
  });
}

function verdictFor(
  key: EntryKey,
  packages: ReadonlyMap<string, PackageHome>,
  program: ts.Program,
): CheckedEntry {
  const home = packages.get(key.package);
  // Nothing of this package is in the program, so there is no surface to hold
  // the entry against. Inert rather than wrong: a project may carry colors for
  // a dependency it has not imported yet.
  if (home === undefined) return { ...key, verdict: "unresolved" };

  const surface = exportSurfaceOf(home, program);
  const reached = surface.declarationsAt(key.subpath, key.symbolPath);
  const [first] = reached;
  if (first === undefined) {
    const published = surface.publishedAt(key.subpath);
    return published.length === 0
      ? { ...key, verdict: "no-subpath", subpaths: surface.subpaths() }
      : { ...key, verdict: "no-key", published };
  }

  // The chain holds one table per package a declaration ships in, so a key
  // this package merely re-exports is looked up under the package that
  // declared it and never under this one.
  const elsewhere = reached.every(
    (declaration) => shipperOf(declaration)?.directory !== home.directory,
  );
  if (!elsewhere) return { ...key, verdict: "reaches" };

  // Which package to key it under is the whole use of this verdict, so a
  // shipper with no npm name is a report of its own rather than a placeholder
  // standing in for one: there is no name to key it under, and that is the
  // fact the reader needs.
  const shipper = shipperOf(first);
  return shipper?.name === undefined
    ? {
        ...key,
        verdict: "unnamed-shipper",
        // A walk that found no `package.json` at all and one that found a
        // nameless file come to the same thing for a reader — there is no name
        // here — so both are reported as the directory the file that would
        // supply one belongs in, rather than as two shapes of message where
        // one of them would name a `.d.ts` and call it a manifest.
        declaredIn:
          shipper?.directory ?? dirname(first.getSourceFile().fileName),
      }
    : { ...key, verdict: "ships-elsewhere", shipsIn: shipper.name };
}

function shipperOf(declaration: ts.Declaration): PackageHome | undefined {
  return packageHomeOf(declaration.getSourceFile().fileName);
}

/**
 * The packages the program holds any file of, by npm name. Nearest wins where
 * two copies of one name are installed: the walk answers per file, and the
 * first is as good a representative as any for a surface both would publish.
 */
function packagesIn(program: ts.Program): ReadonlyMap<string, PackageHome> {
  const homes = new Map<string, PackageHome>();
  for (const sourceFile of program.getSourceFiles()) {
    const home = packageHomeOf(sourceFile.fileName);
    if (home?.name !== undefined && !homes.has(home.name)) {
      homes.set(home.name, home);
    }
  }
  return homes;
}

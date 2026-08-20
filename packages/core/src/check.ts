import { dirname } from "node:path";
import ts from "typescript";
import {
  ambientModuleOf,
  ambientSurfaceOf,
  type AmbientSurface,
} from "./carrier/ambient.js";
import type { ColorTable } from "./carrier/document.js";
import { manifestAt } from "./carrier/manifest.js";
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

/** The three halves of a key into a package's published surface. */
export interface PackageEntryKey {
  readonly kind: "package";
  /** The npm package the entry colors. */
  readonly package: string;
  readonly subpath: string;
  readonly symbolPath: string;
}

/** The two halves of a key into an ambient `declare module` block. */
export interface ModuleEntryKey {
  readonly kind: "module";
  /** The specifier of the block the entry colors. */
  readonly module: string;
  readonly symbolPath: string;
}

/**
 * What a carrier writes an entry under. Two addresses, because there are two
 * surfaces: what a package's entry points publish, and what an ambient block
 * declares — and nothing a block declares is on any package's export surface,
 * which is the whole reason the second exists.
 */
export type EntryKey = PackageEntryKey | ModuleEntryKey;

/** The verdicts both addresses share, because both are surfaces. */
type CommonVerdict =
  | { readonly verdict: "reaches" }
  /**
   * Nothing of the package is in the program, or nothing declares the module,
   * so there is no surface to hold the entry against either way.
   */
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
  /** The surface holds no such key; these are the ones it has. */
  | { readonly verdict: "no-key"; readonly published: readonly string[] };

type PackageVerdict =
  | CommonVerdict
  /**
   * The name is not a package this project holds, and it *is* a block this
   * project declares — so it is the right name written under the wrong table.
   * Told apart from `unresolved` because the two are opposites: one may become
   * right when a dependency is installed, and this one never will.
   */
  | { readonly verdict: "keyed-as-a-package" }
  /**
   * The package publishes no such subpath; these are the ones it has, and
   * these are the blocks it declares instead — which for a `@types` package is
   * the whole of what it has, and the only thing a key could reach.
   */
  | {
      readonly verdict: "no-subpath";
      readonly subpaths: readonly string[];
      readonly blocks: readonly string[];
    }
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
  | { readonly verdict: "unnamed-shipper"; readonly declaredIn: string };

type ModuleVerdict =
  | CommonVerdict
  /**
   * The key resolves, and what it resolves to is written in a different
   * `declare module` block. The block a declaration ships in is what a rung
   * looks it up under — `node:process` re-exports what `process` declares, and
   * an entry under the re-exporting specifier is never consulted.
   */
  | { readonly verdict: "declared-elsewhere"; readonly declaredIn: string }
  /**
   * The key resolves, and what it resolves to is written in no ambient block
   * at all: the block re-exports an ordinary module's symbol, which has a
   * package address rather than a module one.
   */
  | {
      readonly verdict: "not-ambient";
      /** The npm package to key it under, where the walk found a name. */
      readonly shipsIn: string | undefined;
    };

/** One address with one verdict, distributed so `verdict` still discriminates. */
type Checked<Key, Verdict> = Verdict extends unknown ? Key & Verdict : never;

/**
 * What became of one entry. `reaches` is the whole point of the others
 * existing: an entry that colors nothing is indistinguishable from a correct
 * one at a call site, because both come to the same silence.
 *
 * The two addresses carry different verdicts because they have different ways
 * of being wrong, and pairing each with its own keeps a report from having to
 * defend against a combination that cannot arise.
 */
export type CheckedEntry =
  | Checked<PackageEntryKey, PackageVerdict>
  | Checked<ModuleEntryKey, ModuleVerdict>;

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

  // The overlays above are added first on purpose: they are the packages a
  // `modules` table is read from, they share the file name with the manifests
  // below, and `seen` is what keeps one from being reported as the other.
  for (const carrier of unreadModuleTables(packages)) {
    if (seen.has(carrier.path)) continue;
    seen.add(carrier.path);
    carriers.push(carrier);
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
    case "read": {
      // A file naming neither table is the one shape the schema cannot turn
      // away: both are optional, since requiring both would make a project
      // that colors only ambient modules write an empty `packages` to say
      // nothing with. So the report catches it, which is what a `packagez`
      // comes to as well — and it is caught off what the file *names*, since
      // a table its author left empty is one they wrote.
      if (state.named.length === 0) {
        return {
          name,
          path: state.path,
          schema,
          problem: {
            message:
              "it names neither `packages` nor `modules`, so it asserts " +
              "nothing. Those are the two tables read; a key spelled any " +
              "other way is not one of them.",
            fatal: false,
          },
          entries: [],
        };
      }

      const { packages: byPackage, modules } = state.tables;
      return {
        name,
        path: state.path,
        schema,
        entries: [
          ...[...byPackage].flatMap(([owner, table]) =>
            tableEntries(table, owner, packages, program),
          ),
          ...moduleEntries(modules, program),
        ],
      };
    }
  }
}

/**
 * The dependencies that wrote a `modules` table into their own manifest, where
 * nothing reads one.
 *
 * A package's `nothrow.json` is `nothrow emit`'s output, and emit writes only
 * marks it verified against a body — an ambient `declare module` block has none
 * — so the shipped rung does not consult one and `nothrow emit` refuses to
 * write over one. Neither of those reaches a *consumer*: emit runs in the
 * package that publishes, and by the time the file is installed here the only
 * thing left to do about it is say so. A carrier quietly having no effect is
 * the silent no-op the rest of this design exists to rule out, and this is the
 * one channel that can rule it out from this side.
 *
 * Not fatal: it is somebody else's package, and failing a consumer's run over
 * a file they cannot edit would make a dependency's mistake theirs.
 */
function unreadModuleTables(
  packages: ReadonlyMap<string, PackageHome>,
): readonly CheckedCarrier[] {
  const carriers: CheckedCarrier[] = [];

  for (const [name, home] of packages) {
    const state = manifestAt(home);
    if (state.kind !== "valid" || state.modules === undefined) continue;

    carriers.push({
      name,
      path: `${home.directory}/nothrow.json`,
      schema: MANIFEST_SCHEMA_FILE,
      problem: {
        message:
          "it holds a `modules` table, and a package's own manifest is not " +
          "read for one: `nothrow emit` writes only what it verified against " +
          "a body, and an ambient `declare module` block has none. Nothing " +
          "in that table is being honored — those colors carry from an " +
          "`@no-throw/*` overlay, or from your own `nothrow.overrides.json`.",
        fatal: false,
      },
      entries: [],
    });
  }

  return carriers;
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
    const modules = moduleEntries(
      state.modules === undefined ? [] : [state.modules],
      program,
    );

    // An ambient module is nobody's export surface, so a `modules` table is not
    // about the overlay's target — an overlay that carries one and names no
    // package is coloring something, and reporting it as colorless would be
    // wrong about the file in front of the reader. Read off whether the table
    // is *there* rather than off what it produced: an empty one is a table its
    // author wrote, and telling them it is missing sends them to add it twice.
    if (state.target === undefined) {
      return state.modules !== undefined
        ? { name, path, schema, entries: modules }
        : {
            name,
            path,
            schema,
            problem: {
              message:
                "it names no `package` and holds no `modules` table, and an " +
                "overlay's `exports` are matched by that field and by nothing " +
                "else — never by the npm name it was published under — so it " +
                "colors nothing.",
              fatal: true,
            },
            entries: [],
          };
    }

    return {
      name,
      path,
      schema,
      entries: [
        ...tableEntries(state.table, state.target, packages, program),
        ...modules,
      ],
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
    const key = {
      kind: "package",
      package: packageName,
      subpath,
      symbolPath,
    } as const;
    return state.kind === "unusable"
      ? { ...key, verdict: "unusable" as const, faults: state.faults }
      : verdictFor(key, packages, program);
  });
}

/**
 * Every entry of the `modules` tables a carrier holds, which is what the blocks
 * it names declare. Read off the reader for the same reason a package's are:
 * an entry the schema lost is one the file wrote and no key will ever reach.
 *
 * The surface is walked once for all of them, and only where there is an entry
 * to hold against it — a carrier that colors no ambient module pays nothing.
 */
function moduleEntries(
  tables: readonly ColorTable[],
  program: ts.Program,
): readonly CheckedEntry[] {
  const written = tables.flatMap((table) => table.written());
  if (written.length === 0) return [];

  const ambient = ambientSurfaceOf(program);
  return written.map(({ subpath: module, key: symbolPath, state }) => {
    const key = { kind: "module", module, symbolPath } as const;
    return state.kind === "unusable"
      ? { ...key, verdict: "unusable" as const, faults: state.faults }
      : moduleVerdictFor(module, symbolPath, ambient);
  });
}

/**
 * What one module entry came to. The same three questions the package side
 * asks, of the surface that answers here: does the program hold it, does that
 * surface publish this key, and is what the key reaches written in this block
 * rather than merely re-exported through it.
 */
function moduleVerdictFor(
  module: string,
  symbolPath: string,
  ambient: AmbientSurface,
): CheckedEntry {
  const key = { kind: "module", module, symbolPath } as const;

  // Nothing here declares the block, so there is no surface to hold the entry
  // against. Inert rather than wrong, exactly as a package nobody installed is:
  // a project may carry colors for a `node:*` module it has not imported yet.
  if (!ambient.declares(module)) return { ...key, verdict: "unresolved" };

  const reached = ambient.declarationsIn(module, symbolPath);
  const [first] = reached;
  if (first === undefined) {
    return { ...key, verdict: "no-key", published: ambient.publishedIn(module) };
  }

  // A rung looks a declaration up under the block it is *written in*, so a key
  // this block only re-exports is never consulted under this specifier.
  const elsewhere = reached.every(
    (declaration) => ambientModuleOf(declaration) !== module,
  );
  if (!elsewhere) return { ...key, verdict: "reaches" };

  const declaredIn = ambientModuleOf(first);
  return declaredIn === undefined
    ? { ...key, verdict: "not-ambient", shipsIn: shipperOf(first)?.name }
    : { ...key, verdict: "declared-elsewhere", declaredIn };
}

function verdictFor(
  key: PackageEntryKey,
  packages: ReadonlyMap<string, PackageHome>,
  program: ts.Program,
): CheckedEntry {
  const ambient = ambientSurfaceOf(program);
  const home = packages.get(key.package);
  if (home === undefined) {
    // `packages: { "node:path": … }` is the guess this design invites and
    // cannot honor, so it is answered rather than shrugged at: the name is a
    // block, and blocks are keyed one table over.
    return ambient.declares(key.package)
      ? { ...key, verdict: "keyed-as-a-package" }
      : // Nothing of this package is in the program, so there is no surface to
        // hold the entry against. Inert rather than wrong: a project may carry
        // colors for a dependency it has not imported yet.
        { ...key, verdict: "unresolved" };
  }

  const surface = exportSurfaceOf(home, program);
  const reached = surface.declarationsAt(key.subpath, key.symbolPath);
  const [first] = reached;
  if (first === undefined) {
    const published = surface.publishedAt(key.subpath);
    return published.length === 0
      ? {
          ...key,
          verdict: "no-subpath",
          subpaths: surface.subpaths(),
          // A `@types` package publishes nothing *because* its content is
          // blocks, so what it declares is the answer to why it publishes
          // nothing — and the only thing under it a key can reach.
          blocks: ambient.blocksDeclaredIn(home.directory),
        }
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

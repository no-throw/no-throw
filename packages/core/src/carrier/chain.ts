import ts from "typescript";
import { baselineRung } from "../baseline/rung.js";
import { hasDeclaredMark } from "../marks.js";
import type { ColorTable, ColorTables, ManifestEntry } from "./document.js";
import { manifestAt } from "./manifest.js";
import { overlaysFor } from "./overlays.js";
import { overridesIn } from "./overrides.js";
import { packageHomeOf, sameHome, type PackageHome } from "./packages.js";
import { exportSurfaceOf, type ExportKey } from "./surface.js";

/**
 * Why the chain answered *throwing* with nothing an entry could say. These are
 * the carrier's own failures — a manifest that cannot be read, one that no
 * longer matches its files, an entry this release cannot use — as against the
 * ordinary floor, which is what an unanswered question comes to.
 */
export type CarrierFloor =
  | "carried-throwing"
  | "stale-manifest"
  | "unreadable-manifest"
  | "superseded-tag"
  | "unusable-entry";

export type CarrierAnswer =
  | { readonly kind: "entry"; readonly entry: ManifestEntry }
  | {
      readonly kind: "floor";
      readonly reason: CarrierFloor;
      /** The file whose hash drifted; only `stale-manifest` has one. */
      readonly staleFile?: string | undefined;
    };

/**
 * One question, asked of every rung: what does this carrier say about the
 * declaration reached by this key? A rung answers or passes, and the first
 * answer wins — per key, so a rung that knows one symbol leaves the rest to
 * the rungs below it.
 */
export interface CarrierQuery {
  readonly declaration: ts.Declaration;
  /**
   * What the program knows about the declaration beyond where it was written.
   * A rung needs it wherever one declaration is not the whole member — a lib
   * type the project augments has two, and which one arrives here is overload
   * resolution's business rather than a fact about the member.
   */
  readonly checker: ts.TypeChecker;
  /** The package the declaration ships in. */
  readonly home: PackageHome | undefined;
  /** The package the file being analyzed ships in. */
  readonly asking: PackageHome | undefined;
  /** Where the package's published surface reaches it, if it reaches it. */
  readonly key: ExportKey | undefined;
}

export type CarrierRung = (query: CarrierQuery) => CarrierAnswer | undefined;

/**
 * The opaque-resolution seam. Everything the engine cannot read a body for
 * comes through here, and precedence *is* the order of the rungs — there is no
 * separate precedence engine to keep in step with them.
 */
export interface Carrier {
  answerFor(declaration: ts.Declaration): CarrierAnswer | undefined;
}

export function createCarrier(
  sourceFile: ts.SourceFile,
  program: ts.Program,
): Carrier {
  const asking = packageHomeOf(sourceFile.fileName);
  const answers = new Map<ts.Declaration, CarrierAnswer | undefined>();
  const checker = program.getTypeChecker();

  return {
    answerFor(declaration) {
      if (answers.has(declaration)) return answers.get(declaration);

      const home = packageHomeOf(declaration.getSourceFile().fileName);
      const query: CarrierQuery = {
        declaration,
        checker,
        home,
        asking,
        key:
          home === undefined
            ? undefined
            : exportSurfaceOf(home, program).keyOf(declaration),
      };

      let answer: CarrierAnswer | undefined;
      for (const rung of RUNGS) {
        answer = rung(query);
        if (answer !== undefined) break;
      }

      answers.set(declaration, answer);
      return answer;
    },
  };
}

/**
 * What the project itself asserts. The top of the chain, and the rung that
 * makes the floor's outs a promise rather than a suggestion: whatever nobody
 * else has colored, you can color here, and nothing outranks you.
 */
const overridden: CarrierRung = (query) =>
  answerFrom(tableFor(overridesIn(query.asking), query.home), query.key);

/**
 * What somebody else published about the package. Matched by the overlay's
 * manifest `package` field against the npm name of the package the declaration
 * ships in — the overlay's own name is never read.
 */
const overlaid: CarrierRung = (query) =>
  answerFrom(tableFor(overlaysFor(query.asking), query.home), query.key);

/** The table a rung holds for the package this declaration ships in. */
function tableFor(
  tables: ColorTables,
  home: PackageHome | undefined,
): ColorTable | undefined {
  return home?.name === undefined ? undefined : tables.get(home.name);
}

/**
 * One key, in one rung's table. A rung that has no table for the package, or a
 * declaration the package's surface does not publish, passes — which is what
 * makes first-match-wins hold per key rather than per package.
 */
function answerFrom(
  table: ColorTable | undefined,
  key: ExportKey | undefined,
): CarrierAnswer | undefined {
  if (table === undefined || key === undefined) return undefined;

  const entry = table.entryFor(key.subpath, key.symbolPath);
  if (entry === undefined) return undefined;
  return entry.kind === "unusable"
    ? { kind: "floor", reason: "unusable-entry" }
    : { kind: "entry", entry: entry.entry };
}

/**
 * What the package itself ships: a valid manifest, else its surviving tags.
 *
 * The rung is about *somebody else's* package. Your own bodyless declarations
 * are the authoring side, where a mark is rejected outright so that an
 * unverified assertion stays in the overrides channel and an in-source
 * `@nothrow` keeps one meaning — a verified seed.
 */
const shipped: CarrierRung = (query) => {
  const { home, asking, key } = query;
  if (home === undefined || sameHome(home, asking)) return undefined;

  const state = manifestAt(home);

  // A manifest whose facts need a reader this release does not have says
  // nothing this release may guess at, and its tags were written for the same
  // future reading.
  if (state.kind === "unreadable") {
    return { kind: "floor", reason: "unreadable-manifest" };
  }

  // A valid manifest supersedes tags package-wide. Falling back per key would
  // resurrect through a surviving comment exactly the lying mark emit refused
  // to write down.
  if (state.kind === "valid") {
    const answer = answerFrom(state.table, key);
    if (answer !== undefined) return answer;
    // A tag the manifest does not name is superseded rather than absent, and
    // the reader is owed the difference: what is missing is the entry.
    return hasDeclaredMark(query.declaration)
      ? { kind: "floor", reason: "superseded-tag" }
      : undefined;
  }

  // No valid manifest — absent, malformed or hash-failed — so tags carry.
  if (hasDeclaredMark(query.declaration)) {
    // A tag has no place to write conditions, so the absence rule applies to
    // it exactly as it applies to an entry that leaves them out.
    return { kind: "entry", entry: { color: "non-throwing" } };
  }

  return state.kind === "stale"
    ? { kind: "floor", reason: "stale-manifest", staleFile: state.file }
    : undefined;
};

/** The chain, in precedence order. First answer wins, per key. */
const RUNGS: readonly CarrierRung[] = [
  overridden,
  overlaid,
  shipped,
  baselineRung,
];

import ts from "typescript";
import { baselineRung } from "../baseline/rung.js";
import { hasDeclaredMark } from "../marks.js";
import type { TypeFacts } from "../type-facts.js";
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
  readonly facts: TypeFacts;
  /** The package the declaration ships in. */
  readonly home: PackageHome | undefined;
  /** The package the file being analyzed ships in. */
  readonly asking: PackageHome | undefined;
  /**
   * Where the package's published surface reaches it, if it reaches it.
   *
   * A question rather than a field: answering it walks the whole package's
   * export surface, and a rung with no table for the package never needs the
   * answer — which is the common case, since most packages a program pulls in
   * carry nothing at all. #81 measured the eager form as ~29,000 of the ~29,100
   * type-system queries a run of this engine over its own sources makes.
   */
  key(): ExportKey | undefined;
}

export type CarrierRung = (query: CarrierQuery) => CarrierAnswer | undefined;

/**
 * The opaque-resolution seam. Everything the engine cannot read a body for
 * comes through here, and precedence *is* the order of the rungs — there is no
 * separate precedence engine to keep in step with them.
 */
export interface Carrier {
  answerFor(declaration: ts.Declaration): CarrierAnswer | undefined;
  /**
   * Where the published surface reaches the declaration, if it reaches it —
   * whether a consumer *could* have keyed it, which is a different question
   * from whether anybody did. A caller deciding to ask about something else
   * instead needs the first: a key nobody wrote is still that member's key,
   * and reaching past it would answer for one member out of another's entry.
   */
  keyFor(declaration: ts.Declaration): ExportKey | undefined;
}

export function createCarrier(
  sourceFile: ts.SourceFile,
  program: ts.Program,
  facts: TypeFacts,
): Carrier {
  const asking = packageHomeOf(sourceFile.fileName);
  // The one rung whose file belongs to the project doing the asking, so it is
  // read once here rather than per query — and a file this release cannot
  // honor therefore refuses before any declaration is looked up, rather than
  // at whichever call happened to reach the chain first.
  const rungs = [overriddenBy(overridesIn(asking)), ...RUNGS];

  const answers = new Map<ts.Declaration, CarrierAnswer | undefined>();

  interface Located {
    readonly home: PackageHome | undefined;
    key(): ExportKey | undefined;
  }
  const located = new Map<ts.Declaration, Located>();

  // Where the declaration ships and what its package publishes it as, which
  // both questions below need and neither owns. The home is a walk up the
  // file's directories; the key is a walk of the package's whole export
  // surface, so it is asked at most once per declaration and only by a caller
  // that has something to look it up in. Absence is an answer, so the flag
  // rather than the value is what records that it has been asked.
  const locate = (declaration: ts.Declaration): Located => {
    const known = located.get(declaration);
    if (known !== undefined) return known;

    const home = packageHomeOf(declaration.getSourceFile().fileName);
    let asked = false;
    let key: ExportKey | undefined;
    const at: Located = {
      home,
      key: () => {
        if (!asked) {
          asked = true;
          key =
            home === undefined
              ? undefined
              : exportSurfaceOf(home, program, facts).keyOf(declaration);
        }
        return key;
      },
    };
    located.set(declaration, at);
    return at;
  };

  return {
    answerFor(declaration) {
      if (answers.has(declaration)) return answers.get(declaration);

      const { home, key } = locate(declaration);
      const query: CarrierQuery = {
        declaration,
        facts,
        home,
        asking,
        key,
      };

      let answer: CarrierAnswer | undefined;
      for (const rung of rungs) {
        answer = rung(query);
        if (answer !== undefined) break;
      }

      answers.set(declaration, answer);
      return answer;
    },
    keyFor: (declaration) => locate(declaration).key(),
  };
}

/**
 * What the project itself asserts. The top of the chain, and the rung that
 * makes the floor's outs a promise rather than a suggestion: whatever nobody
 * else has colored, you can color here, and nothing outranks you.
 */
function overriddenBy(overrides: ColorTables): CarrierRung {
  return (query) => answerFrom(tableFor(overrides, query.home), query);
}

/**
 * What somebody else published about the package. Matched by the overlay's
 * manifest `package` field against the npm name of the package the declaration
 * ships in — the overlay's own name is never read.
 */
const overlaid: CarrierRung = (query) =>
  answerFrom(tableFor(overlaysFor(query.asking), query.home), query);

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
  query: CarrierQuery,
): CarrierAnswer | undefined {
  if (table === undefined) return undefined;
  const key = query.key();
  if (key === undefined) return undefined;

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
  const { home, asking } = query;
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
    const answer = answerFrom(state.table, query);
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

/**
 * The chain below the overrides, in precedence order. First answer wins, per
 * key. The overrides rung is built per carrier and sits above these.
 */
const RUNGS: readonly CarrierRung[] = [overlaid, shipped, baselineRung];

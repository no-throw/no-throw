import ts from "typescript";
import { hasDeclaredMark } from "../marks.js";
import { manifestAt, type ManifestEntry } from "./manifest.js";
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
 *
 * v1 composes one rung, the shipped one. Overrides and overlays go in front of
 * it and the baseline behind it, each a `CarrierRung` and nothing else.
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

  return {
    answerFor(declaration) {
      if (answers.has(declaration)) return answers.get(declaration);

      const home = packageHomeOf(declaration.getSourceFile().fileName);
      const query: CarrierQuery = {
        declaration,
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
    const entry =
      key === undefined
        ? undefined
        : state.entryFor(key.subpath, key.symbolPath);
    if (entry !== undefined) {
      return entry.kind === "unusable"
        ? { kind: "floor", reason: "unusable-entry" }
        : { kind: "entry", entry: entry.entry };
    }
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
const RUNGS: readonly CarrierRung[] = [shipped];

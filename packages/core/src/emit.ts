import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import ts from "typescript";
import { formatConditionPath } from "./baseline/paths.js";
import { createCarrier } from "./carrier/chain.js";
import type { ManifestEntry } from "./carrier/document.js";
import { integrityOf } from "./carrier/manifest.js";
import {
  join,
  normalize,
  packageHomeOf,
  type PackageHome,
} from "./carrier/packages.js";
import { validate } from "./carrier/schema.js";
import { manifestSchema } from "./carrier/schemas.js";
import {
  surfaceOver,
  type ExportKey,
  type ExportSurface,
} from "./carrier/surface.js";
import type { Condition } from "./conditions.js";
import { findMarks, seedDeclaration, type MarkProblemKind } from "./marks.js";
import { isVisiblyAsync } from "./promises.js";
import { createColorResolver, type BodyEscape } from "./resolve-color.js";

/** The wire version this release writes, which is the one it reads. */
const VERSION = 1;

/** One npm export subpath's entries, keyed by symbol path. */
type Subpath = Readonly<Record<string, ManifestEntry>>;

/** A manifest as it goes on the wire. */
export interface ManifestDocument {
  readonly $schema?: string;
  readonly version: number;
  readonly package?: string;
  readonly exports: Readonly<Record<string, Subpath>>;
  readonly files: Readonly<Record<string, string>>;
}

/** A place a refusal points at. Positions are one-based, as a reader counts. */
export interface EmitSite {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  /** What is there, in a few words. */
  readonly what?: string;
}

/**
 * One mark nothing can be published for. A refusal is the whole of emit's
 * contract: a published manifest is true by construction, so a mark the engine
 * cannot verify — or cannot lower into a shape emit is allowed to write — stops
 * the file rather than being quietly left out of it.
 */
export interface MarkRefusal {
  readonly message: string;
  /** Where the mark is. */
  readonly at: EmitSite;
  /** The places the message refers to. */
  readonly sites: readonly EmitSite[];
}

export type EmitOutcome =
  | {
      readonly kind: "manifest";
      /** Where the file belongs: beside the package's `package.json`. */
      readonly path: string;
      readonly document: ManifestDocument;
      /** The bytes to write, canonical, so two runs of one source agree. */
      readonly text: string;
    }
  /**
   * Nothing was read, so nothing was written: no `tsconfig.json`, no build on
   * disk, nowhere a `nothrow.json` would be found. Apart from `refused`
   * because it says nothing about the package — emit never got as far as a
   * mark — and a host that reported it as a verdict would be inventing one.
   * One reason, because the first of them stops everything.
   */
  | { readonly kind: "blocked"; readonly message: string }
  /** Nothing was written, and the reasons are marks. Never empty. */
  | { readonly kind: "refused"; readonly refusals: readonly MarkRefusal[] };

/**
 * Lower a package's verified marks into a manifest.
 *
 * The host builds the program; everything else is the engine's, because what
 * a mark comes to is the same question the enforcement walk asks and there
 * must not be a second answer to it. Marks are found by the binding rule,
 * verified by the color resolver, and keyed by the export surface the package
 * publishes — the same three pieces the consumer's side of the wire uses,
 * turned around.
 */
export function emitManifest(
  program: ts.Program,
  commandLine: ts.ParsedCommandLine,
): EmitOutcome {
  const configPath = commandLine.options.configFilePath;
  if (typeof configPath !== "string") {
    return blocked(
      "emit needs the `tsconfig.json` a program was built from: without it " +
        "there is no way to say which files the package publishes.",
    );
  }

  const home = packageHomeOf(configPath);
  if (home === undefined) {
    return blocked(
      "no `package.json` above this project, so there is nowhere a " +
        "`nothrow.json` would be found: a manifest is discovered as the " +
        "sibling of the first `package.json` a consumer's walk-up reaches.",
    );
  }

  const sources = sourcesOf(program, home);
  const published = publishedFiles(sources, commandLine);
  if (published.kind === "missing") {
    return blocked(
      `\`${relativeTo(home, published.file)}\` does not exist, so the ` +
        "package's own files cannot be hashed. `nothrow emit` runs after the " +
        "build, on what is about to be published — that is what makes a " +
        "consumer's staleness check mean anything.",
    );
  }

  const surface = surfaceOver(
    entryPointSources(home, sources, commandLine),
    program,
  );
  const collected = collectEntries(sources, program, surface);
  if (collected.kind === "refused") return collected;

  const document: ManifestDocument = {
    ...schemaUrl(),
    version: VERSION,
    ...(home.name === undefined ? {} : { package: home.name }),
    exports: collected.exports,
    files: Object.fromEntries(
      published.files
        .map((file) => [relativeTo(home, file), integrityOf(file)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };

  // The schema is the contract hand-authors validate against, so an emitter
  // that drifted from it would publish something the reader refuses. Checking
  // here costs one pass and makes that impossible rather than unlikely.
  if (validate(manifestSchema(), document, []).length > 0) {
    return blocked(
      "emit produced a manifest that does not validate against " +
        "`nothrow.schema.json`, which is a bug in `nothrow emit`.",
    );
  }

  return {
    kind: "manifest",
    path: join(home.directory, "nothrow.json"),
    document,
    text: `${JSON.stringify(document, undefined, 2)}\n`,
  };
}

/**
 * Why emit must not write over the manifest already there, or nothing where it
 * may. Asked before drift, because it is not a difference to reconcile: a
 * `modules` table is something no run of emit could ever produce, so "run
 * `nothrow emit` and commit the result" would be an instruction to delete it.
 *
 * The table is legal in the two files that are read for one — a project's
 * `nothrow.overrides.json` and an overlay — and refused here rather than
 * ignored, because a carrier quietly having no effect is the silent no-op the
 * rest of this design exists to rule out.
 */
export function unwritableManifest(onDisk: unknown): string | undefined {
  return isRecord(onDisk) && "modules" in onDisk
    ? "it holds a `modules` table, and emit writes only marks it verified " +
        "against a body — an ambient `declare module` block has none, so no " +
        "run of emit could produce that table and writing this file would " +
        "discard it. Colors for an ambient module belong in a project's " +
        "`nothrow.overrides.json`, or in a `@no-throw/*` overlay, which are " +
        "the carriers read for one"
    : undefined;
}

/**
 * How a manifest on disk differs from the one emit would write now, in one
 * sentence, or nothing where it does not. Drift is *any* difference: a
 * rebuilt `.js` with identical declarations changes no color and still
 * invalidates the manifest, because the hash is what a consumer checks.
 */
export function manifestDrift(
  onDisk: unknown,
  fresh: ManifestDocument,
): string | undefined {
  if (!isRecord(onDisk)) return "it is not a JSON object";

  if (onDisk["version"] !== fresh.version) {
    return (
      `\`version\` is ${JSON.stringify(onDisk["version"])}, ` +
      `and emit writes ${fresh.version}`
    );
  }
  if (onDisk["package"] !== fresh.package) {
    return (
      `\`package\` is ${JSON.stringify(onDisk["package"])}, ` +
      `and emit writes ${JSON.stringify(fresh.package)}`
    );
  }

  const exportsDiff = exportsDrift(onDisk["exports"], fresh.exports);
  if (exportsDiff !== undefined) return exportsDiff;

  return filesDrift(onDisk["files"], fresh.files);
}

function exportsDrift(
  onDisk: unknown,
  fresh: ManifestDocument["exports"],
): string | undefined {
  if (!isRecord(onDisk)) return "`exports` is missing or is not an object";

  for (const subpath of union(Object.keys(onDisk), Object.keys(fresh))) {
    const written = onDisk[subpath];
    if (written !== undefined && !isRecord(written)) {
      return `\`${subpath}\` is not a set of entries`;
    }
    // A subpath with no entries is the same thing as one that is not there, so
    // both sides are compared key by key and the difference is always named.
    const there = written ?? {};
    const here = fresh[subpath] ?? {};

    for (const key of union(Object.keys(there), Object.keys(here))) {
      const before = there[key];
      const now = here[key];
      const at = `\`${subpath}\` → \`${key}\``;
      if (before === undefined) {
        return `emit writes ${at}, and the manifest does not have it`;
      }
      if (now === undefined) {
        return `the manifest has ${at}, and emit no longer writes it`;
      }
      if (canonical(before) !== canonical(now)) {
        return (
          `${at} is ${canonical(before)}, and emit writes ${canonical(now)}`
        );
      }
    }
  }
  return undefined;
}

function filesDrift(
  onDisk: unknown,
  fresh: ManifestDocument["files"],
): string | undefined {
  if (!isRecord(onDisk)) return "`files` is missing or is not an object";

  for (const file of union(Object.keys(onDisk), Object.keys(fresh))) {
    if (onDisk[file] !== fresh[file]) {
      return onDisk[file] === undefined
        ? `\`${file}\` is published now and the manifest does not hash it`
        : fresh[file] === undefined
          ? `\`${file}\` is hashed by the manifest and is not published now`
          : `\`${file}\` hashes differently than when the manifest was written`;
    }
  }
  return undefined;
}

/** Every entry, or the refusals that stopped the file from being written. */
function collectEntries(
  sources: readonly ts.SourceFile[],
  program: ts.Program,
  surface: ExportSurface,
):
  | { readonly kind: "exports"; readonly exports: ManifestDocument["exports"] }
  | { readonly kind: "refused"; readonly refusals: readonly MarkRefusal[] } {
  const refusals: MarkRefusal[] = [];
  const entries = new Map<string, Map<string, ManifestEntry>>();

  for (const sourceFile of sources) {
    const marks = findMarks(sourceFile);

    for (const problem of marks.problems) {
      refusals.push(
        unboundRefusal(sourceFile, problem.kind, problem.span.start),
      );
    }

    // Built per file, as the enforcement walk builds it: the chain's first
    // question is which package is asking.
    const colors = createColorResolver({
      checker: program.getTypeChecker(),
      carrier: createCarrier(sourceFile, program),
    });

    for (const seed of marks.bound) {
      // Every mark is verified, published or not: an internal one pins its own
      // color, so a lie inside the package reaches the entries that are.
      const escapes = colors.escapesIn(seed);
      const key = keyOf(seed, surface);
      const at = siteOf(sourceFile, seed.getStart(sourceFile));

      if (escapes.length > 0) {
        refusals.push(unverifiedRefusal(seed, escapes, at));
        continue;
      }
      if (key === undefined) continue;

      if (
        ts.isGetAccessorDeclaration(seed) ||
        ts.isSetAccessorDeclaration(seed)
      ) {
        refusals.push(accessorRefusal(key, at));
        continue;
      }

      const entry = entryFor(seed, colors.conditionsIn(seed));
      const bySymbol =
        entries.get(key.subpath) ?? new Map<string, ManifestEntry>();
      entries.set(key.subpath, bySymbol);

      const already = bySymbol.get(key.symbolPath);
      if (already !== undefined && canonical(already) !== canonical(entry)) {
        refusals.push(conflictRefusal(key, at));
        continue;
      }
      bySymbol.set(key.symbolPath, entry);
    }
  }

  if (refusals.length > 0) return { kind: "refused", refusals };

  return {
    kind: "exports",
    exports: Object.fromEntries(
      [...entries]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([subpath, bySymbol]) => [
          subpath,
          Object.fromEntries(
            [...bySymbol].sort(([a], [b]) => a.localeCompare(b)),
          ),
        ]),
    ),
  };
}

/**
 * What a verified mark comes to on the wire. `conditions` is written even when
 * it is empty — especially when it is empty: absence means maximally
 * conditioned, so unconditional cleanliness has to be recorded positively.
 */
function entryFor(
  seed: ts.FunctionLikeDeclaration,
  conditions: readonly Condition[],
): ManifestEntry {
  return {
    color: "non-throwing",
    // Declaration emit erases the keyword, so the entry is the only place a
    // consumer can learn the call rejects rather than sync-throws.
    ...(isVisiblyAsync(seed) ? { async: true } : {}),
    conditions: conditions
      .map(({ path }) =>
        formatConditionPath({
          // A body's conditions are all paths it enters: an absence form is a
          // claim about a body nobody can read, which is why only a carrier
          // states one and emit never writes one.
          requires: "entered",
          paramIndex: path.paramIndex,
          segments: path.members.map(
            (name) => ({ kind: "member", name }) as const,
          ),
        }),
      )
      .sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Where the package's surface reaches a seed. A mark on an arrow binds to the
 * arrow, and what a consumer names is the declaration it initializes — a
 * `const`, a class field, a default export — so the key is looked up for the
 * declaration the surface actually walked, through the same type-only wrappers
 * the binder read the initializer past.
 */
function keyOf(
  seed: ts.FunctionLikeDeclaration,
  surface: ExportSurface,
): ExportKey | undefined {
  const declaration = seedDeclaration(seed);
  return declaration === undefined ? undefined : surface.keyOf(declaration);
}

/** The package's own source: what a mark can be written in and verified against. */
function sourcesOf(
  program: ts.Program,
  home: PackageHome,
): readonly ts.SourceFile[] {
  return program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        !sourceFile.isDeclarationFile &&
        packageHomeOf(sourceFile.fileName)?.directory === home.directory,
    )
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

type PublishedFiles =
  | { readonly kind: "files"; readonly files: readonly string[] }
  | { readonly kind: "missing"; readonly file: string };

/**
 * What this build puts on disk for the package's sources: its JavaScript and
 * its declarations both, because drift lives in `.js` bodies and is invisible
 * at declaration granularity — hashing the declarations alone would validate
 * happily while shipped behavior changed.
 *
 * Files this build does not produce are not hashed, and need not be: an entry
 * is only ever written for a symbol reached from a source file in this
 * program, so every body a color was read off is in here. What a second build
 * step ships alongside carries no entries, and a valid manifest supersedes
 * tags package-wide, so those symbols floor rather than going stale.
 */
function publishedFiles(
  sources: readonly ts.SourceFile[],
  commandLine: ts.ParsedCommandLine,
): PublishedFiles {
  const files: string[] = [];

  for (const sourceFile of sources) {
    for (const output of outputsOf(sourceFile.fileName, commandLine)) {
      if (!existsSync(output)) return { kind: "missing", file: output };
      files.push(output);
    }
  }

  return { kind: "files", files };
}

/**
 * A source file's outputs, source maps excluded: a map changes no behavior and
 * a consumer never resolves one, so hashing it would report drift for a
 * rebuild that changed nothing.
 */
function outputsOf(
  fileName: string,
  commandLine: ts.ParsedCommandLine,
): readonly string[] {
  return ts
    .getOutputFileNames(commandLine, fileName, !ts.sys.useCaseSensitiveFileNames)
    .filter((output) => !output.endsWith(".map"));
}

/**
 * The package's entry points, in the sources emit can read marks from. A
 * `package.json` names built files, and the marks are in what built them —
 * so the mapping is the compiler's own, and a package publishing its `.ts`
 * source is matched directly.
 */
function entryPointSources(
  home: PackageHome,
  sources: readonly ts.SourceFile[],
  commandLine: ts.ParsedCommandLine,
): ReadonlyMap<string, readonly string[]> {
  // Both sides of the lookup are normalized: an entry point is spelled the way
  // its `package.json` author typed it, and a source file the way the program
  // reached it, so neither can be found with the other's string.
  const bySource = new Map<string, string>();
  for (const sourceFile of sources) {
    const normalized = normalize(sourceFile.fileName);
    bySource.set(normalized, normalized);
    for (const output of outputsOf(sourceFile.fileName, commandLine)) {
      bySource.set(normalize(output), normalized);
    }
  }

  const points = new Map<string, readonly string[]>();
  for (const [subpath, files] of home.entryPoints) {
    const found = files
      .map((file) => bySource.get(file))
      .filter((file): file is string => file !== undefined);
    if (found.length > 0) points.set(subpath, found);
  }
  return points;
}

function unverifiedRefusal(
  seed: ts.FunctionLikeDeclaration,
  escapes: readonly BodyEscape[],
  at: EmitSite,
): MarkRefusal {
  return {
    message:
      `${describe(seed)} is marked \`@nothrow\`, and its body escapes. A ` +
      "published manifest is true by construction, so emit refuses a color " +
      "the engine cannot verify: bridge the escapes below, or drop the mark.",
    at,
    sites: escapes.map(({ kind, node }) =>
      siteOf(node.getSourceFile(), node.getStart(), ESCAPES[kind]),
    ),
  };
}

function accessorRefusal(key: ExportKey, at: EmitSite): MarkRefusal {
  return {
    message:
      `\`${key.symbolPath}\` is marked \`@nothrow\` on an accessor, and a ` +
      "manifest states an accessor's color only as an accessor fact — a " +
      "shape `nothrow emit` never writes. Declaration emit preserves `get` " +
      "and `set`, so consumers already see the accessor; its color belongs " +
      "in their `nothrow.overrides.json`, or in an `@no-throw/*` overlay.",
    at,
    sites: [],
  };
}

/**
 * Two marks under one key. Not a shape an author writes directly — a mark
 * binds to an implementation, and overloads share one — but declaration
 * merging can put two bodies behind one published name, and dropping one of
 * two disagreeing colors silently is the one thing emit must not do.
 */
function conflictRefusal(key: ExportKey, at: EmitSite): MarkRefusal {
  return {
    message:
      `\`${key.symbolPath}\` is published once and marked twice, with ` +
      "colors that disagree. One entry covers one symbol, so there is no " +
      "manifest that says both.",
    at,
    sites: [],
  };
}

/** Why a mark bound to nothing, in the clause the refusal reads into. */
const UNBOUND: Record<MarkProblemKind, string> = {
  "non-jsdoc-mark": "a mark is read only from a JSDoc block comment",
  "misspelled-mark": "the mark is spelled `@nothrow`, and this is not",
  "ineffective-mark": "nothing here is a site a mark binds on",
  "ineffective-mark-no-site": "nothing here is a site a mark binds on",
  "multi-declarator":
    "a variable statement declaring more than one variable would leave which " +
    "one is marked a guess",
  "non-function-value":
    "this declaration's value is not a function written at it",
  "mark-on-call-argument":
    "a function written as a call argument has no declaration to bind to",
  "mark-on-assignment": "an assignment is not a declaration",
  "ambient-declaration":
    "an ambient declaration has no body to verify it against",
  "interface-member": "an interface member has no body to verify it against",
  "abstract-method": "an abstract method has no body to verify it against",
  "overload-signature":
    "an overload signature has no body to verify it against",
};

function unboundRefusal(
  sourceFile: ts.SourceFile,
  kind: MarkProblemKind,
  start: number,
): MarkRefusal {
  return {
    message:
      `\`@nothrow\` binds to nothing here: ${UNBOUND[kind]}. Every mark in ` +
      "the package has to bind before any of them can be published — " +
      "`nothrow/valid-mark` reports this one in full.",
    at: siteOf(sourceFile, start),
    sites: [],
  };
}

/**
 * The escape in a few words. What it is in full — why it floored, and the outs
 * — is the rule's to say; here the reader has already been told which mark is
 * refused and needs only the places to look.
 */
const ESCAPES: Record<BodyEscape["kind"], string> = {
  throw: "an uncaught `throw`",
  callee: "a call that can throw",
  "argument-throwing":
    "an argument that does not discharge the callee's condition",
  "argument-floored":
    "an argument that does not discharge the callee's condition",
  "argument-present":
    "an argument at a position the callee is only clean without",
  consumption: "consuming an iterator that can throw",
  "iterator-throw": "`.throw()` on an iterator",
  "returned-iterator": "an iterator handed out that can throw when consumed",
  "rejected-await": "an `await` on a promise that can reject",
  float: "a discarded promise that can reject",
  "rejected-return": "a returned promise that can reject",
  "hidden-transfer":
    "a property access or coercion that runs a body which can throw",
};

/** What the message calls the marked function. */
function describe(seed: ts.FunctionLikeDeclaration): string {
  const named = ts.isVariableDeclaration(seed.parent)
    ? seed.parent.name
    : ts.getNameOfDeclaration(seed);
  return named === undefined ? "this function" : `\`${named.getText()}\``;
}

function siteOf(
  sourceFile: ts.SourceFile,
  start: number,
  what?: string,
): EmitSite {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    fileName: sourceFile.fileName,
    line: line + 1,
    column: character + 1,
    ...(what === undefined ? {} : { what }),
  };
}

function blocked(message: string): EmitOutcome {
  return { kind: "blocked", message };
}

/** The schema's own `$id`, so what a manifest points at cannot drift from it. */
function schemaUrl(): { readonly $schema?: string } {
  const schema = manifestSchema();
  const id = isRecord(schema) ? schema["$id"] : undefined;
  return typeof id === "string" ? { $schema: id } : {};
}

function relativeTo(home: PackageHome, path: string): string {
  return `./${relative(home.directory, path).split(sep).join("/")}`;
}

/**
 * JSON with its keys in one order. Two entries are the same fact whatever
 * order they were written in, so a reformatted manifest is not drift.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function union(a: readonly string[], b: readonly string[]): readonly string[] {
  return [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

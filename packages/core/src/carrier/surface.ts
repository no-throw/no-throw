import ts from "typescript";
import type { SymbolRef, TypeFacts } from "../type-facts.js";
import { normalize, type PackageHome } from "./packages.js";

/** Where a package's published surface reaches a declaration. */
export interface ExportKey {
  /** The npm export subpath it is reached through. */
  readonly subpath: string;
  /** A strict JSDoc-namepath subset: `name`, `Class#member`, `Class.static`. */
  readonly symbolPath: string;
}

/**
 * A package's public surface, walked from its entry points inward.
 *
 * Keys are read off the surface rather than off the declaration because that is
 * what a consumer can actually name: `export { a as b }` publishes `b`, and a
 * symbol declared in `./dist/inner.d.ts` and re-exported from the entry point is
 * published at `.`, not at a file nobody imports. A declaration the walk never
 * reaches has no key, and a rung with no key to look up cannot answer for it.
 */
export interface ExportSurface {
  keyOf(declaration: ts.Declaration): ExportKey | undefined;
}

/**
 * How far a namepath may reach into a published symbol. The grammar is open —
 * `A.B.C#d` is legal — but a chain has to stop somewhere, and nothing beyond a
 * class's own members has shown up on a real export surface.
 */
const MAX_DEPTH = 4;

const surfaces = new WeakMap<ts.Program, Map<string, ExportSurface>>();

export function exportSurfaceOf(
  home: PackageHome,
  program: ts.Program,
  facts: TypeFacts,
): ExportSurface {
  const byPackage = surfaces.get(program) ?? new Map<string, ExportSurface>();
  surfaces.set(program, byPackage);

  const known = byPackage.get(home.directory);
  if (known !== undefined) return known;

  const surface = surfaceOver(home.entryPoints, program, facts);
  byPackage.set(home.directory, surface);
  return surface;
}

/**
 * The same walk over entry points named directly. A publisher's key has to be
 * read off the files a consumer will resolve, which the emitter reaches from
 * its own sources rather than from the built files a `package.json` names — so
 * both sides compute one thing the same way.
 */
export function surfaceOver(
  entryPoints: ReadonlyMap<string, readonly string[]>,
  program: ts.Program,
  facts: TypeFacts,
): ExportSurface {
  const keys = new Map<ts.Declaration, ExportKey>();

  // Sorted so that a symbol two subpaths both publish is keyed the same way
  // whatever order the `package.json` happened to list them in.
  for (const subpath of [...entryPoints.keys()].sort()) {
    for (const file of entryPoints.get(subpath) ?? []) {
      const sourceFile = sourceFileAt(file, program);
      if (sourceFile === undefined) continue;
      for (const module of modulesIn(sourceFile, facts)) {
        for (const exported of facts.exportsOfModule(module)) {
          record(keys, facts, subpath, facts.nameOf(exported), exported, 0);
        }
      }
    }
  }

  return { keyOf: (declaration) => keys.get(declaration) };
}

/**
 * Record every declaration this published name reaches, then its own members.
 * An alias is followed first: what a manifest keys is the name the consumer
 * writes, and the declaration behind it is wherever the package put it.
 */
function record(
  keys: Map<ts.Declaration, ExportKey>,
  facts: TypeFacts,
  subpath: string,
  symbolPath: string,
  symbol: SymbolRef,
  depth: number,
): void {
  const resolved = facts.isAlias(symbol) ? facts.aliasedSymbol(symbol) : symbol;

  for (const declaration of facts.declarationsOf(resolved)) {
    // First path wins: a symbol two entry points both publish is one symbol
    // with one color, and re-keying it would make the answer depend on order.
    if (!keys.has(declaration)) keys.set(declaration, { subpath, symbolPath });
  }

  if (depth >= MAX_DEPTH) return;

  for (const [name, member] of facts.membersOfSymbol(resolved)) {
    if (isWritable(name)) {
      record(keys, facts, subpath, `${symbolPath}#${name}`, member, depth + 1);
    }
  }
  // A class's statics and a namespace's contents are the same table, and both
  // are reached with a dot.
  for (const [name, member] of facts.exportsOfSymbol(resolved)) {
    if (isWritable(name)) {
      record(keys, facts, subpath, `${symbolPath}.${name}`, member, depth + 1);
    }
  }
}

/** A member the key grammar can hold: no computed names, no symbol members. */
function isWritable(name: string): boolean {
  return SEGMENT.test(name);
}

const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * The modules a file publishes. A file with top-level `export`s is one; a
 * script declaring `declare module "pkg"` — the shape hand-written `@types`
 * packages take — publishes one per declaration instead.
 */
function modulesIn(
  sourceFile: ts.SourceFile,
  facts: TypeFacts,
): readonly SymbolRef[] {
  const own = facts.symbolAt(sourceFile);
  if (own !== undefined) return [own];

  const ambient: SymbolRef[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isModuleDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.name)) continue;
    const symbol = facts.symbolAt(statement.name);
    if (symbol !== undefined) ambient.push(symbol);
  }
  return ambient;
}

const files = new WeakMap<ts.Program, Map<string, ts.SourceFile>>();

/**
 * The program's file under the one spelling both sides can agree on. The
 * program spells a path the way module resolution reached it and a
 * `package.json` spells it the way its author typed it, so neither can be
 * looked up with the other's string.
 */
function sourceFileAt(
  file: string,
  program: ts.Program,
): ts.SourceFile | undefined {
  let index = files.get(program);
  if (index === undefined) {
    index = new Map(
      program.getSourceFiles().map((each) => [normalize(each.fileName), each]),
    );
    files.set(program, index);
  }
  return index.get(file);
}

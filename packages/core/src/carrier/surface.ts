import ts from "typescript";
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
): ExportSurface {
  const byPackage = surfaces.get(program) ?? new Map<string, ExportSurface>();
  surfaces.set(program, byPackage);

  const known = byPackage.get(home.directory);
  if (known !== undefined) return known;

  const surface = buildSurface(home, program);
  byPackage.set(home.directory, surface);
  return surface;
}

function buildSurface(home: PackageHome, program: ts.Program): ExportSurface {
  const checker = program.getTypeChecker();
  const keys = new Map<ts.Declaration, ExportKey>();

  // Sorted so that a symbol two subpaths both publish is keyed the same way
  // whatever order the `package.json` happened to list them in.
  for (const subpath of [...home.entryPoints.keys()].sort()) {
    for (const file of home.entryPoints.get(subpath) ?? []) {
      const sourceFile = sourceFileAt(file, program);
      if (sourceFile === undefined) continue;
      for (const module of modulesIn(sourceFile, checker)) {
        for (const exported of checker.getExportsOfModule(module)) {
          record(keys, checker, subpath, exported.getName(), exported, 0);
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
  checker: ts.TypeChecker,
  subpath: string,
  symbolPath: string,
  symbol: ts.Symbol,
  depth: number,
): void {
  const resolved = aliasedSymbol(symbol, checker);

  for (const declaration of resolved.declarations ?? []) {
    // First path wins: a symbol two entry points both publish is one symbol
    // with one color, and re-keying it would make the answer depend on order.
    if (!keys.has(declaration)) keys.set(declaration, { subpath, symbolPath });
  }

  if (depth >= MAX_DEPTH) return;

  for (const [name, member] of resolved.members ?? []) {
    if (isWritable(name)) {
      record(keys, checker, subpath, `${symbolPath}#${name}`, member, depth + 1);
    }
  }
  // A class's statics and a namespace's contents are the same table, and both
  // are reached with a dot.
  for (const [name, member] of resolved.exports ?? []) {
    if (isWritable(name)) {
      record(keys, checker, subpath, `${symbolPath}.${name}`, member, depth + 1);
    }
  }
}

function aliasedSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) === 0
    ? symbol
    : checker.getAliasedSymbol(symbol);
}

/** A member the key grammar can hold: no computed names, no symbol members. */
function isWritable(name: ts.__String): name is ts.__String & string {
  return typeof name === "string" && SEGMENT.test(name);
}

const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * The modules a file publishes. A file with top-level `export`s is one; a
 * script declaring `declare module "pkg"` — the shape hand-written `@types`
 * packages take — publishes one per declaration instead.
 */
function modulesIn(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): readonly ts.Symbol[] {
  const own = checker.getSymbolAtLocation(sourceFile);
  if (own !== undefined) return [own];

  const ambient: ts.Symbol[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isModuleDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.name)) continue;
    const symbol = checker.getSymbolAtLocation(statement.name);
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

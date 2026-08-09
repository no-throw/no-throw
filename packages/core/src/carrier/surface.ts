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
  /**
   * Every symbol path a key lookup at this subpath can succeed with, sorted.
   * The walk is the only thing that knows what a key could have been, so what
   * an entry keyed at nothing should have said is read off it rather than
   * guessed at — and read off the keys the walk *kept*, since a path it
   * reached and then lost to first-path-wins is a path no lookup will find.
   */
  publishedAt(subpath: string): readonly string[];
  /** The subpaths the walk reached anything through, sorted. */
  subpaths(): readonly string[];
  /** What a key reaches, which is what a rung would answer about. */
  declarationsAt(subpath: string, symbolPath: string): readonly ts.Declaration[];
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

  const surface = surfaceOver(home.entryPoints, program);
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
): ExportSurface {
  const checker = program.getTypeChecker();
  const keys = new Map<ts.Declaration, ExportKey>();

  // Sorted so that a symbol two subpaths both publish is keyed the same way
  // whatever order the `package.json` happened to list them in.
  for (const subpath of [...entryPoints.keys()].sort()) {
    for (const file of entryPoints.get(subpath) ?? []) {
      const sourceFile = sourceFileAt(file, program);
      if (sourceFile === undefined) continue;
      for (const module of modulesIn(sourceFile, checker)) {
        for (const [name, exported] of publishedBy(module, checker)) {
          record(keys, checker, subpath, name, exported, 0);
        }
      }
    }
  }

  // Inverted from the keys themselves rather than collected during the walk:
  // what a lookup can find is exactly what survived first-path-wins, and a
  // path the walk reached and then lost would be a key nothing resolves.
  const reached = new Map<string, Map<string, ts.Declaration[]>>();
  for (const [declaration, { subpath, symbolPath }] of keys) {
    const at = reached.get(subpath) ?? new Map<string, ts.Declaration[]>();
    reached.set(subpath, at);
    at.set(symbolPath, [...(at.get(symbolPath) ?? []), declaration]);
  }

  return {
    keyOf: (declaration) => {
      const direct = keys.get(declaration);
      if (direct !== undefined) return direct;

      const holder = typeHolderOf(declaration);
      return holder === undefined ? undefined : keys.get(holder);
    },
    publishedAt: (subpath) =>
      [...(reached.get(subpath)?.keys() ?? [])].sort((a, b) =>
        a.localeCompare(b),
      ),
    subpaths: () => [...reached.keys()].sort((a, b) => a.localeCompare(b)),
    declarationsAt: (subpath, symbolPath) =>
      reached.get(subpath)?.get(symbolPath) ?? [],
  };
}

/**
 * The names a module publishes, each with the symbol behind it.
 *
 * `export =` is the shape a CommonJS package's declarations take, and the
 * checker reports no exports at all for one: there is no export table to walk,
 * because the module *is* the exported value. What a consumer can name through
 * it is what that value's type carries, so those are its published names —
 * `m.red` reached the same way `export const red` would have been.
 */
function publishedBy(
  module: ts.Symbol,
  checker: ts.TypeChecker,
): readonly (readonly [string, ts.Symbol])[] {
  const assigned = exportedValueOf(module, checker);
  if (assigned !== undefined) {
    return checker
      .getPropertiesOfType(assigned)
      .map((property) => [property.getName(), property] as const);
  }
  return checker
    .getExportsOfModule(module)
    .map((exported) => [exported.getName(), exported] as const);
}

/** The type of what `export =` assigned, where the module assigned one. */
function exportedValueOf(
  module: ts.Symbol,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const assignment = module.exports?.get(ts.InternalSymbolName.ExportEquals);
  if (assignment === undefined) return undefined;

  const resolved = aliasedSymbol(assignment, checker);
  const at = resolved.valueDeclaration ?? resolved.declarations?.[0];
  return at === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(resolved, at);
}

/**
 * The declaration a bare function type is the type *of*. Declaration emit turns
 * a default-exported arrow and an arrow-valued field alike into a `const` or a
 * property whose type is a function type, and that type node is what the
 * checker resolves a call to. What the surface publishes is the declaration, so
 * the type node has to reach it, or a key emit wrote could never be looked up.
 *
 * Only a declaration's own type counts: a function type nested inside a wider
 * one is not something the surface reaches.
 */
function typeHolderOf(node: ts.Declaration): ts.Declaration | undefined {
  if (!ts.isFunctionTypeNode(node) && !ts.isConstructorTypeNode(node)) {
    return undefined;
  }

  const { parent } = node;
  return (ts.isVariableDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent)) &&
    parent.type === node
    ? parent
    : undefined;
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

  for (const spelling of spellingsOf(file)) {
    const found = index.get(spelling);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * How a program could be holding this entry point.
 *
 * A `package.json` names what a *runtime* resolves, and most of npm names
 * nothing else — `"exports": { ".": "./index.js" }` beside an `index.d.ts` is
 * the ordinary published shape. What a program holds for such a package is the
 * declaration file, never the JavaScript, so an entry point is also asked for
 * under the declaration extension TypeScript pairs it with: the same mapping
 * module resolution itself applies, and the only spelling of that file the
 * program has.
 */
function spellingsOf(file: string): readonly string[] {
  for (const [runtime, declaration] of DECLARATIONS_FOR) {
    if (file.endsWith(runtime)) {
      return [file, `${file.slice(0, -runtime.length)}${declaration}`];
    }
  }
  return [file];
}

const DECLARATIONS_FOR: readonly (readonly [string, string])[] = [
  [".js", ".d.ts"],
  [".jsx", ".d.ts"],
  [".mjs", ".d.mts"],
  [".cjs", ".d.cts"],
];

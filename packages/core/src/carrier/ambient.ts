import ts from "typescript";
import { namepathsIn, typeHolderOf } from "./surface.js";

/** Where an ambient `declare module` block's surface reaches a declaration. */
export interface AmbientKey {
  /** The specifier the block was written under: `node:path`, `stream`. */
  readonly module: string;
  /** The same JSDoc-namepath subset a package key's second half uses. */
  readonly symbolPath: string;
}

/**
 * The address of everything a package's entry points cannot reach.
 *
 * `node:path` and its siblings are not npm packages: they are ambient `declare
 * module` blocks inside `@types/node`, and the walk that assigns package keys
 * starts at a package's entry points — which reach the *files* those blocks are
 * written in and never the blocks themselves. So the top three carriers had no
 * key over any of them, and the bridge was the only out a reader had: the one
 * place in this design where a project was blocked on nobody.
 *
 * The block is the surface, so the specifier is the address. Which block a
 * declaration belongs to is read the way its package is — off where it *ships*,
 * never off what re-exported it — and what a consumer may call it is read off
 * the block's own published surface, by the same walk an npm subpath's is.
 */

/**
 * The specifier of the block a declaration is written in, whether or not the
 * block publishes it under any name.
 *
 * A floor needs the difference between this and a key: a declaration with a
 * specifier and no key is one no carrier can reach, and naming the modules
 * carrier as an out over one would name a door that does not open.
 */
export function ambientModuleOf(
  declaration: ts.Declaration,
): string | undefined {
  return blockOf(declaration)?.name.text;
}

/** Where that block's published surface reaches it, if it reaches it. */
export function ambientKeyOf(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): AmbientKey | undefined {
  const block = blockOf(declaration);
  if (block === undefined) return undefined;

  const module = checker.getSymbolAtLocation(block.name);
  if (module === undefined) return undefined;

  const keys = namepathsCached(module, checker);
  const holder = typeHolderOf(declaration);
  const symbolPath =
    keys.get(declaration) ??
    (holder === undefined ? undefined : keys.get(holder));
  return symbolPath === undefined
    ? undefined
    : { module: block.name.text, symbolPath };
}

/**
 * The same addressing asked backwards: from a specifier and a namepath to what
 * they reach. Only `nothrow check` asks this way — a resolved call already has
 * a declaration in hand — so the scan over every file in the program that finds
 * the blocks is paid here and not on the resolver's path.
 */
export interface AmbientSurface {
  /** Whether anything in the program declares this specifier at all. */
  declares(module: string): boolean;
  /** Every namepath a lookup under this specifier can succeed with, sorted. */
  publishedIn(module: string): readonly string[];
  /** What a key reaches, which is what a rung would answer about. */
  declarationsIn(module: string, symbolPath: string): readonly ts.Declaration[];
}

const surfaces = new WeakMap<ts.Program, AmbientSurface>();

export function ambientSurfaceOf(program: ts.Program): AmbientSurface {
  const known = surfaces.get(program);
  if (known !== undefined) return known;

  const surface = build(program);
  surfaces.set(program, surface);
  return surface;
}

function build(program: ts.Program): AmbientSurface {
  const checker = program.getTypeChecker();
  const blocks = declaredModules(program, checker);
  const reached = new Map<string, ReadonlyMap<string, ts.Declaration[]>>();

  const membersOf = (module: string): ReadonlyMap<string, ts.Declaration[]> => {
    const known = reached.get(module);
    if (known !== undefined) return known;

    const symbol = blocks.get(module);
    const members = new Map<string, ts.Declaration[]>();
    if (symbol !== undefined) {
      for (const [declaration, symbolPath] of namepathsCached(symbol, checker)) {
        members.set(symbolPath, [
          ...(members.get(symbolPath) ?? []),
          declaration,
        ]);
      }
    }
    reached.set(module, members);
    return members;
  };

  return {
    declares: (module) => blocks.has(module),
    publishedIn: (module) =>
      [...membersOf(module).keys()].sort((a, b) => a.localeCompare(b)),
    declarationsIn: (module, symbolPath) =>
      membersOf(module).get(symbolPath) ?? [],
  };
}

const walks = new WeakMap<
  ts.TypeChecker,
  Map<ts.Symbol, ReadonlyMap<ts.Declaration, string>>
>();

/** One block's surface, walked once per checker however often it is asked. */
function namepathsCached(
  module: ts.Symbol,
  checker: ts.TypeChecker,
): ReadonlyMap<ts.Declaration, string> {
  let walked = walks.get(checker);
  if (walked === undefined) {
    walked = new Map();
    walks.set(checker, walked);
  }

  const known = walked.get(module);
  if (known !== undefined) return known;

  const keys = namepathsIn(module, checker);
  walked.set(module, keys);
  return keys;
}

type AmbientBlock = ts.ModuleDeclaration & { readonly name: ts.StringLiteral };

/** The block a declaration is written in, however deep inside it it sits. */
function blockOf(declaration: ts.Node): AmbientBlock | undefined {
  for (
    let node: ts.Node | undefined = declaration.parent;
    node !== undefined;
    node = node.parent
  ) {
    // A `declare global` block inside one is still inside it: what publishes
    // `NodeJS.Process#exit` is the `declare module "process"` around the global
    // block it is written in, and that is the block a key names.
    if (isAmbientBlock(node)) return node;
  }
  return undefined;
}

function isAmbientBlock(node: ts.Node): node is AmbientBlock {
  return ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name);
}

/**
 * Every ambient module the program declares, by specifier. Merged declarations
 * are one symbol, so the first block found answers for all of them — which is
 * what the checker would say too, since the symbol is what it is asked for.
 */
function declaredModules(
  program: ts.Program,
  checker: ts.TypeChecker,
): ReadonlyMap<string, ts.Symbol> {
  const modules = new Map<string, ts.Symbol>();

  for (const sourceFile of program.getSourceFiles()) {
    for (const statement of sourceFile.statements) {
      if (!isAmbientBlock(statement)) continue;
      if (modules.has(statement.name.text)) continue;

      const symbol = checker.getSymbolAtLocation(statement.name);
      if (symbol !== undefined) modules.set(statement.name.text, symbol);
    }
  }

  return modules;
}

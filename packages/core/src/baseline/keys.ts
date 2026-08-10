/**
 * Baseline keys name a member the way the engine will meet it: by the
 * *declaring* interface and the member's own name. That is the one thing a
 * resolver can read off a symbol with no heuristics — `Array#push` from a
 * `push` declared in `interface Array<T>`, `ArrayConstructor#from` from the
 * constructor interface, `parseInt` from a top-level `declare function`.
 *
 * Well-known symbols spell as `@@name`, the same dialect the condition paths
 * use, so `[Symbol.iterator]` is `Array#@@iterator`.
 */
import ts from "typescript";

export function memberKey(owner: string, member: string): string {
  return `${owner}#${member}`;
}

/**
 * The static side, when there is no named interface to carry it. ES libs give
 * the constructor object its own interface (`ArrayConstructor`), so `#` covers
 * both sides there; `lib.dom.d.ts` writes it as an anonymous type literal on
 * `declare var Element`, leaving the variable's name as the only thing a
 * resolver can read. `.` separates it, which is the same JSDoc namepath
 * dialect the manifest keys use, and it keeps `Response.json` (static) apart
 * from `Response#json` (instance) — a collision `lib.dom.d.ts` really contains.
 */
export function staticMemberKey(owner: string, member: string): string {
  return `${owner}.${member}`;
}

/** `[Symbol.iterator]` → `@@iterator`; a plain name passes through. */
export function symbolMemberName(text: string): string {
  const match = /^\[\s*Symbol\.([A-Za-z_$][\w$]*)\s*\]$/.exec(text);
  return match?.[1] !== undefined ? `@@${match[1]}` : text;
}

/** `…/lib.es2015.core.d.ts` → `es2015.core`; anything else is not a lib file. */
export function libTargetOfFileName(fileName: string): string | undefined {
  return /(?:^|[\\/])lib\.([\w.]+)\.d\.ts$/.exec(fileName)?.[1];
}

/** A member as one of the lib files declares it. */
export interface LibDeclaration {
  readonly declaration: ts.Declaration;
  readonly libTarget: string;
}

/**
 * Where the libs declare the member this declaration declares — every place,
 * not just this one.
 *
 * A project may augment a lib type, and `interface Array<T> { push(…) }` beside
 * a polyfill is ordinary TypeScript rather than a corner. The member then has
 * declarations in two files, only one of them a lib file, and overload
 * resolution hands back whichever it matched — so reading the lib target off
 * the declaration in hand answers by coin toss, and every reading that turns on
 * "is this a builtin?" answers with it. Declaration merging cannot introduce a
 * body, so what it produces is one member with several descriptions, and it is
 * the member the baseline colors.
 *
 * The symbol is what says so. An interface named `Array` inside a module
 * declares its own member and merges with nothing, so it has no lib declaration
 * here and is answered like any other hand-written type — which a rule written
 * over the *name* could not have told apart.
 */
export function libDeclarationsOf(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): readonly LibDeclaration[] {
  return declarationsOfMember(declaration, checker).flatMap((declared) => {
    const libTarget = libTargetOfFileName(declared.getSourceFile().fileName);
    return libTarget === undefined ? [] : [{ declaration: declared, libTarget }];
  });
}

/**
 * Every declaration of the member, this one included. A signature with no name
 * — a call or construct signature — is the one shape the symbol cannot be
 * reached through, and it is also the one shape nothing merges into.
 */
function declarationsOfMember(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): readonly ts.Declaration[] {
  const name = ts.getNameOfDeclaration(declaration);
  const declarations =
    name === undefined
      ? undefined
      : checker.getSymbolAtLocation(name)?.declarations;
  return declarations === undefined || declarations.length === 0
    ? [declaration]
    : declarations;
}

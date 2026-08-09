/**
 * The segments a key is built out of, for every carrier that builds one.
 *
 * A key is separator-joined segments, and two of them name members that have
 * no name of their own. That is not a corner: a call resolves to the signature,
 * not to the property whose *type* carries it, so `pc.red(text)` lands inside
 * `interface Formatter` rather than on `Colors#red`, and without a spelling for
 * the signature there is nothing a consumer could write that reaches it.
 *
 * TypeScript files those members under `__call`, `__new` and `__constructor`,
 * which are its own names for them rather than anybody's key — so the spellings
 * live here, one set for the export surface and the baseline both, because the
 * two carriers answer for the same concept and a second copy is a second thing
 * to keep in step.
 */
import ts from "typescript";

/** A call signature: `Formatter#()`, `ArrayConstructor#()`. */
export const CALL_SEGMENT = "()";

/**
 * A construct signature or a class constructor: `Wrapper#new()`. One spelling
 * for both, because `new X(…)` is what reaches either.
 *
 * Not `new`, and that is forced rather than chosen: `new` is a legal property
 * name, so `interface F { new (): T; new: string }` is ordinary TypeScript, and
 * a segment spelled `new` would file its two members under one key and color
 * both from an entry written for one. Any segment that is *itself* a legal
 * identifier collides that way; these two are not, and a member literally named
 * `"()"` or `"new()"` is turned away by `keySegment` exactly as it is today.
 */
export const CONSTRUCT_SEGMENT = "new()";

/** What TypeScript files an unnamed member under, and what a key calls it. */
const SIGNATURES: ReadonlyMap<string, string> = new Map([
  [ts.InternalSymbolName.Call, CALL_SEGMENT],
  [ts.InternalSymbolName.New, CONSTRUCT_SEGMENT],
  [ts.InternalSymbolName.Constructor, CONSTRUCT_SEGMENT],
]);

/** A member whose name a key holds as it is written. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * A name TypeScript reserved for itself. Exactly two leading underscores says
 * so: the binder gives a member somebody really wrote a third one, so `__index`
 * is the compiler's and `___x` is a source `__x`.
 */
const RESERVED = /^__(?!_)/u;

/**
 * One member of a symbol table, as a key segment, or nothing where the grammar
 * has no spelling for it — an index signature, an `export *`, a computed name.
 *
 * The escaping is undone on the way out. A member table holds escaped names and
 * a key holds source ones, so a package publishing `__weird` is keyed for the
 * name its consumer can see rather than for the one the binder stored.
 */
export function keySegment(name: ts.__String): string | undefined {
  if (typeof name !== "string") return undefined;

  const signature = SIGNATURES.get(name);
  if (signature !== undefined) return signature;
  if (RESERVED.test(name)) return undefined;

  const written = ts.unescapeLeadingUnderscores(name);
  return IDENTIFIER.test(written) ? written : undefined;
}

/**
 * The segment a declaration is keyed by where it is one of the two unnamed
 * shapes, and nothing where it has a name of its own to be keyed by.
 *
 * The API is passed in rather than imported, as everything the baseline
 * generators call is, so the drift gate can read a different release's nodes.
 */
export function signatureSegment(
  tsApi: typeof ts,
  declaration: ts.Declaration,
): string | undefined {
  if (tsApi.isCallSignatureDeclaration(declaration)) return CALL_SEGMENT;
  return tsApi.isConstructSignatureDeclaration(declaration) ||
    tsApi.isConstructorDeclaration(declaration)
    ? CONSTRUCT_SEGMENT
    : undefined;
}

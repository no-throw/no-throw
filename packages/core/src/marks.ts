import ts from "typescript";
import { hasModifier, isAmbient } from "./declarations.js";

/** Source text offsets, `[start, end)`, that a diagnostic is anchored to. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The ways a `@nothrow` tag fails to bind. Each cause reports itself, and only
 * what that cause lets it say truthfully: the bodyless family is called out
 * member by member because each has a different out — an ambient declaration
 * belongs in the overrides file, an overload belongs on its implementation —
 * and a function with no declaration at all is told something different again
 * from a declaration holding something that is not a function.
 *
 * The first two are near misses — a mark that never reached the binder as one,
 * because of the comment it was written in or the way it was spelled. Both are
 * settled before position, since a near miss on a perfectly valid site is
 * exactly the silent no-op the design rules out.
 */
export type MarkProblemKind =
  | "non-jsdoc-mark"
  | "misspelled-mark"
  | "ineffective-mark"
  | "ineffective-mark-no-site"
  | "multi-declarator"
  | "non-function-value"
  | "mark-on-call-argument"
  | "mark-on-assignment"
  | "ambient-declaration"
  | "interface-member"
  | "abstract-method"
  | "overload-signature";

export interface MarkProblem {
  readonly kind: MarkProblemKind;
  readonly span: Span;
  /**
   * Message parameters; `ineffective-mark` carries `site` and `line`,
   * `non-function-value` carries `declaration`, `non-jsdoc-mark` carries `tag`
   * and `form`, `misspelled-mark` carries `tag`.
   */
  readonly data: Readonly<Record<string, string>>;
}

export interface Marks {
  /**
   * The seeds, in source order. This is what the enforcement walk checks and
   * what the manifest emitter scans: one rule, both consumers.
   */
  readonly bound: readonly ts.FunctionLikeDeclaration[];
  readonly problems: readonly MarkProblem[];
}

/**
 * Bind every `@nothrow` in a file, or say why it does not bind. A mark that
 * neither binds nor is reported would be a silent no-op, which is the one
 * outcome the design rules out — so a tag that is nearly the mark, and a mark
 * written in a comment JSDoc does not read, are reported too.
 */
export function findMarks(sourceFile: ts.SourceFile): Marks {
  const problems: MarkProblem[] = [];
  // A function has one color however many times it is claimed, so a repeated
  // tag must not enforce — or emit — the same body twice.
  const bound = new Set<ts.FunctionLikeDeclaration>();

  for (const { tag, host } of jsdocTags(sourceFile)) {
    const span = spanOfTag(tag, sourceFile);
    const name = tag.tagName.text;

    if (name !== MARK) {
      if (normalize(name) === MARK) {
        problems.push({ kind: "misspelled-mark", span, data: { tag: name } });
      }
      continue;
    }

    const target = bindingTarget(host);
    if (target === undefined) {
      problems.push(problemFor(host, span, sourceFile));
    } else {
      bound.add(target);
    }
  }

  problems.push(...nonJsdocMarks(sourceFile));

  return { bound: [...bound], problems };
}

/**
 * Whether a declaration is a bound seed: the same rule as `findMarks`,
 * asked one declaration at a time, which is what resolving a callee's color
 * needs. Both routes go through `bindingTarget`, so they cannot disagree.
 */
export function isMarkedFunction(declaration: ts.Node): boolean {
  const host = markHostOf(declaration);
  if (host === undefined) return false;
  return bindingTarget(host) === declaration && nothrowTagsOn(host).length > 0;
}

/**
 * The declaration a bound seed was written on: itself where it carries its own
 * body, and the declaration it initializes where it is a function literal. This
 * is what a *consumer* names — a mark on an arrow reaches the wire under the
 * `const`, the field or the default export it initializes — so the emitter keys
 * a seed by asking this rather than by inverting the binder a second time.
 */
export function seedDeclaration(
  seed: ts.FunctionLikeDeclaration,
): ts.Declaration | undefined {
  if (canCarryBody(seed)) return seed;

  const holder = holderOf(seed);
  if (holder === undefined) return undefined;
  return ts.isVariableDeclaration(holder) ||
    ts.isPropertyAssignment(holder) ||
    ts.isPropertyDeclaration(holder) ||
    ts.isExportAssignment(holder)
    ? holder
    : undefined;
}

/**
 * A `@nothrow` written directly on a declaration, with no binding rule applied
 * and no body behind it. This is the carrier reading of the tag rather than
 * the authoring one: on a bodyless declaration a dependency ships, the tag is
 * *trusted as an assertion* — the same trust class as the declaration's types
 * — because the real seam is body visibility, not the package boundary.
 */
export function hasDeclaredMark(declaration: ts.Node): boolean {
  return nothrowTagsOn(declaration).length > 0;
}

/**
 * The construct a mark for this declaration would have to be written on: the
 * inverse of `bindingTarget`, and it has to stay one. Where the two disagree,
 * `isMarkedFunction` and `findMarks` disagree about the same source — one
 * enforcing a mark the other never bound, or the reverse.
 */
function markHostOf(declaration: ts.Node): ts.Node | undefined {
  if (canCarryBody(declaration)) return declaration;
  if (
    !ts.isFunctionExpression(declaration) &&
    !ts.isArrowFunction(declaration)
  ) {
    return undefined;
  }

  const parent = holderOf(declaration);
  if (parent === undefined) return undefined;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isExportAssignment(parent)
  ) {
    return parent;
  }
  if (!ts.isVariableDeclaration(parent)) return undefined;

  const statement = parent.parent.parent;
  return ts.isVariableStatement(statement) ? statement : undefined;
}

/**
 * What holds a function literal, looking past the same wrappers the initializer
 * is read through. Written off the same predicate as the peel so the two cannot
 * drift apart.
 */
function holderOf(value: ts.Node): ts.Node | undefined {
  let current: ts.Node = value;
  while (isTypeWrapper(current.parent)) current = current.parent;
  return current.parent;
}

/**
 * Every JSDoc tag in the file, paired with the construct it directly precedes.
 * Every tag, not only the mark's, because a tag that is *nearly* the mark has
 * to be caught before it is dismissed as somebody else's.
 */
function jsdocTags(
  sourceFile: ts.SourceFile,
): { tag: ts.JSDocTag; host: ts.Node }[] {
  const found: { tag: ts.JSDocTag; host: ts.Node }[] = [];

  const visit = (node: ts.Node): void => {
    if (carriesJSDoc(node, sourceFile)) {
      for (const tag of jsdocTagsOn(node)) found.push({ tag, host: node });
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
  return found;
}

function nothrowTagsOn(host: ts.Node): ts.JSDocTag[] {
  return jsdocTagsOn(host).filter((tag) => tag.tagName.text === MARK);
}

/**
 * Attribution is the parser's lexical one — the node whose leading trivia the
 * comment sits in. `getJSDocTags`' climb to enclosing nodes is discarded, so
 * what a mark binds to is decided by `bindingTarget` and nowhere else.
 */
function jsdocTagsOn(host: ts.Node): ts.JSDocTag[] {
  return ts.getJSDocTags(host).filter((tag) => tag.parent.parent === host);
}

/**
 * A node whose own leading trivia holds a JSDoc comment starts earlier when
 * asked to include it. That is the cheap public test for "worth asking about
 * tags at all"; `getJSDocTags` itself climbs, and climbing every node is the
 * cost this avoids.
 */
function carriesJSDoc(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  return (
    node.getStart(sourceFile, /* includeJsDocComment */ true) !==
    node.getStart(sourceFile)
  );
}

/** The `@nothrow` text itself: where you wrote it is where it is reported. */
function spanOfTag(tag: ts.JSDocTag, sourceFile: ts.SourceFile): Span {
  return { start: tag.getStart(sourceFile), end: tag.tagName.end };
}

const MARK = "nothrow";

/**
 * Case and separators are the noise a near miss is written in: `@No_Throw` is
 * this tag, misspelled. Anything else is a different tag the engine has no
 * business guessing at, which is why `@nothrowx` stays silent by design.
 */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

/** The comment forms the parser reads no tags out of at all. */
type PlainForm = "line" | "block";

interface CommentTag {
  readonly name: string;
  readonly form: PlainForm;
  readonly span: Span;
}

/**
 * The marks written in a comment JSDoc never looks inside — a line comment, or
 * a one-star block. There is no tag list to consult for these, so they are read
 * out of the source text, and reported however they are spelled: a mark whose
 * comment is wrong is wrong before its spelling or its position is worth
 * discussing.
 */
function nonJsdocMarks(sourceFile: ts.SourceFile): MarkProblem[] {
  const problems: MarkProblem[] = [];

  for (const { name, form, span } of plainCommentTags(sourceFile)) {
    if (normalize(name) === MARK) {
      problems.push({ kind: "non-jsdoc-mark", span, data: { tag: name, form } });
    }
  }

  return problems;
}

/**
 * The leading `@tag` of every line of every plain comment. The trivia scanned
 * is the trivia the parser reads JSDoc from, so a plain comment is judged in
 * exactly the places a JSDoc one would have been.
 */
function plainCommentTags(sourceFile: ts.SourceFile): CommentTag[] {
  const { text } = sourceFile;
  const found: CommentTag[] = [];
  // Every node starting at the same token shares its leading trivia, and a
  // deep tree has many, so each stretch of trivia is scanned once.
  const scanned = new Set<number>();

  const visit = (node: ts.Node): void => {
    if (!scanned.has(node.pos)) {
      scanned.add(node.pos);
      for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
        const form = plainForm(text, range);
        if (form !== undefined) found.push(...tagsIn(text, range, form));
      }
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
  return found;
}

/** The comment's form, or nothing at all if the parser reads its tags. */
function plainForm(
  text: string,
  range: ts.CommentRange,
): PlainForm | undefined {
  if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) return "line";
  // What the parser calls JSDoc: opens with `/**`, and is not the empty `/**/`.
  const jsdoc = text.startsWith("/**", range.pos) && text[range.pos + 3] !== "/";
  return jsdoc ? undefined : "block";
}

const MARGIN_THEN_AT = /^[ \t]*\**[ \t]*@/;
/**
 * `-` and `_` are name characters, matching the parser, so a near miss spelled
 * with one is read whole rather than cut short at the separator.
 */
const TAG_NAME = /[\w$-]+/y;

/**
 * A tag is what starts a comment line once the delimiter and the margin are
 * off. JSDoc is looser — it reads one mid-sentence too — but this net is cast
 * over prose the parser never claimed, so `// TODO: mark this @nothrow` has to
 * stay prose.
 */
function tagsIn(
  text: string,
  range: ts.CommentRange,
  form: PlainForm,
): CommentTag[] {
  const found: CommentTag[] = [];

  // From past the `//` or `/*` on, every line is margin and then content.
  for (let start = range.pos + 2; start < range.end; ) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 || newline >= range.end ? range.end : newline;

    const margin = MARGIN_THEN_AT.exec(text.slice(start, end))?.[0];
    if (margin !== undefined) {
      const at = start + margin.length - 1;
      const name = tagNameAt(text, at + 1);
      if (name !== "") {
        const span = { start: at, end: at + 1 + name.length };
        found.push({ name, form, span });
      }
    }

    start = end + 1;
  }

  return found;
}

function tagNameAt(text: string, position: number): string {
  TAG_NAME.lastIndex = position;
  return TAG_NAME.exec(text)?.[0] ?? "";
}

/** The syntactic positions a mark may occupy. */
type ValidSite =
  | ts.FunctionDeclaration
  | ts.VariableStatement
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.PropertyDeclaration
  | ts.PropertyAssignment
  | ts.ExportAssignment;

/**
 * The construct a mark binds to, or nothing.
 *
 * > `@nothrow` binds where it is written on a **declaration whose own body —
 * > or whose initializer, read through parentheses, `as` and `satisfies` — is
 * > exactly one function literal**.
 *
 * A rule rather than a list of positions, because a list sprouts edges: five
 * of them in one sitting, among them the default export, which is a key the
 * namepath grammar names and no mark could ever have produced. A body is
 * required throughout, so the bodyless family is refused by the rule itself
 * rather than beside it, and it stops at declarations, which is what keeps the
 * rule identical to the emitter's scan set — a function with no declaration
 * has no namepath to key.
 */
function bindingTarget(host: ts.Node): ts.FunctionLikeDeclaration | undefined {
  if (canCarryBody(host)) return host.body === undefined ? undefined : host;

  if (ts.isVariableStatement(host)) {
    const declarations = host.declarationList.declarations;
    if (declarations.length !== 1) return undefined;
    return asFunction(declarations[0]?.initializer);
  }

  if (ts.isPropertyAssignment(host) || ts.isPropertyDeclaration(host)) {
    return asFunction(host.initializer);
  }

  if (ts.isExportAssignment(host)) return asFunction(host.expression);

  return undefined;
}

function isValidSite(node: ts.Node): node is ValidSite {
  return bindingTarget(node) !== undefined;
}

function asFunction(
  initializer: ts.Expression | undefined,
): ts.FunctionLikeDeclaration | undefined {
  if (initializer === undefined) return undefined;
  const value = unwrapped(initializer);
  return ts.isFunctionExpression(value) || ts.isArrowFunction(value)
    ? value
    : undefined;
}

/**
 * An initializer with its type-only wrappers off. Parentheses, `as` and
 * `satisfies` change nothing about which body is there, so peeling them binds
 * the same claim the author wrote. An identifier is never peeled: that would
 * let the claim be written in one file and checked in another.
 */
function unwrapped(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (isTypeWrapper(current)) current = current.expression;
  return current;
}

type TypeWrapper =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression;

function isTypeWrapper(node: ts.Node | undefined): node is TypeWrapper {
  return (
    node !== undefined &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node))
  );
}

function problemFor(
  host: ts.Node,
  span: Span,
  sourceFile: ts.SourceFile,
): MarkProblem {
  const kind = problemKind(host);

  if (kind === "non-function-value") {
    return { kind, span, data: { declaration: describeHolder(host, sourceFile) } };
  }
  if (kind !== "ineffective-mark") return { kind, span, data: {} };

  const site = nearestValidSite(host);
  if (site === undefined) {
    return { kind: "ineffective-mark-no-site", span, data: {} };
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(
    site.getStart(sourceFile),
  );
  return {
    kind,
    span,
    data: { site: describeSite(site, sourceFile), line: String(line + 1) },
  };
}

function problemKind(host: ts.Node): MarkProblemKind {
  if (isAmbient(host)) return "ambient-declaration";
  if (isTypeMember(host)) return "interface-member";
  if (hasModifier(host, ts.SyntaxKind.AbstractKeyword)) return "abstract-method";
  if (isBodylessImplementable(host)) return "overload-signature";
  if (
    ts.isVariableStatement(host) &&
    host.declarationList.declarations.length > 1
  ) {
    return "multi-declarator";
  }
  if (canHoldAFunction(host)) return "non-function-value";
  // The two positions where climbing to a valid site would be wrong advice
  // rather than merely unhelpful: both are functions, and moving the mark up
  // to the enclosing one claims something else entirely.
  if (isCallArgument(host)) return "mark-on-call-argument";
  if (isAssignment(host)) return "mark-on-assignment";
  return "ineffective-mark";
}

/** The declarations the rule reads an initializer off. */
type Holder =
  | ts.VariableStatement
  | ts.PropertyAssignment
  | ts.PropertyDeclaration
  | ts.ExportAssignment;

/**
 * A declaration the rule would have bound a mark on, had the function been
 * written there. What is wrong with it is its *value*, so it is told that
 * rather than pointed at some other site.
 */
function canHoldAFunction(host: ts.Node): host is Holder {
  return (
    ts.isPropertyAssignment(host) ||
    ts.isPropertyDeclaration(host) ||
    ts.isExportAssignment(host) ||
    ts.isVariableStatement(host)
  );
}

/** A function literal handed straight to a call, with no declaration of its own. */
function isCallArgument(host: ts.Node): boolean {
  if (!ts.isFunctionExpression(host) && !ts.isArrowFunction(host)) return false;
  const holder = holderOf(host);
  return (
    holder !== undefined &&
    (ts.isCallExpression(holder) || ts.isNewExpression(holder)) &&
    holder.arguments?.some((argument) => unwrapped(argument) === host) === true
  );
}

/**
 * An assignment, reached from either end: the statement a mark written above it
 * lands on, and the function literal a mark written inline lands on.
 */
function isAssignment(host: ts.Node): boolean {
  const node = ts.isExpressionStatement(host) ? host.expression : holderOf(host);
  return (
    node !== undefined &&
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/** A member of an `interface` or an object type literal: never has a body. */
function isTypeMember(node: ts.Node): boolean {
  return (
    ts.isMethodSignature(node) ||
    ts.isPropertySignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isIndexSignatureDeclaration(node)
  );
}

/**
 * A declaration that could have carried a body and does not. In a
 * non-ambient, non-abstract position TypeScript admits exactly one such
 * shape: an overload signature.
 */
function isBodylessImplementable(node: ts.Node): boolean {
  return canCarryBody(node) && node.body === undefined;
}

type BodyBearing =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** The declarations TypeScript writes a body onto, present or not. */
function canCarryBody(node: ts.Node): node is BodyBearing {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Where the author probably meant to put the mark: the first valid site the
 * marked construct contains, else the nearest one enclosing it.
 */
function nearestValidSite(host: ts.Node): ValidSite | undefined {
  const contained = firstContainedSite(host);
  if (contained !== undefined) return contained;

  for (let n = host.parent; n !== undefined; n = n.parent) {
    if (isValidSite(n)) return n;
  }
  return undefined;
}

function firstContainedSite(node: ts.Node): ValidSite | undefined {
  let found: ValidSite | undefined;

  const visit = (child: ts.Node): void => {
    if (found !== undefined) return;
    if (isValidSite(child)) {
      found = child;
      return;
    }
    child.forEachChild(visit);
  };

  node.forEachChild(visit);
  return found;
}

function describeSite(site: ValidSite, sourceFile: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(site)) return "the constructor";
  if (ts.isExportAssignment(site)) return "the default export";

  const name = declaredName(site, sourceFile);
  const noun = siteNoun(site);
  return name === undefined ? `the ${noun}` : `the ${noun} \`${name}\``;
}

function siteNoun(site: ValidSite): string {
  if (ts.isGetAccessorDeclaration(site)) return "getter";
  if (ts.isSetAccessorDeclaration(site)) return "setter";
  if (ts.isMethodDeclaration(site)) return "method";
  if (ts.isPropertyAssignment(site) || ts.isPropertyDeclaration(site)) {
    return "property";
  }
  return "function";
}

/**
 * What the reader calls the declaration the mark is on. Nothing here is a
 * function, so there is no noun to give it beyond the name it was declared
 * under — and a default export has no name at all.
 */
function describeHolder(host: ts.Node, sourceFile: ts.SourceFile): string {
  if (ts.isExportAssignment(host)) return "the default export";
  const name = canHoldAFunction(host)
    ? declaredName(host, sourceFile)
    : undefined;
  return name === undefined ? "this declaration" : `\`${name}\``;
}

/** The name a declaration was written under, reaching into a variable statement. */
function declaredName(
  node: ts.Declaration | ts.VariableStatement,
  sourceFile: ts.SourceFile,
): string | undefined {
  const declaration = ts.isVariableStatement(node)
    ? node.declarationList.declarations[0]
    : node;
  return declaration === undefined
    ? undefined
    : ts.getNameOfDeclaration(declaration)?.getText(sourceFile);
}

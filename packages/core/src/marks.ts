import ts from "typescript";
import { hasModifier, isAmbient } from "./declarations.js";

/** Source text offsets, `[start, end)`, that a diagnostic is anchored to. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The ways a `@nothrow` tag fails to bind. The bodyless family is called out
 * member by member because each has a different out: an ambient declaration
 * belongs in the overrides file, an overload belongs on its implementation.
 */
export type MarkProblemKind =
  | "ineffective-mark"
  | "ineffective-mark-no-site"
  | "multi-declarator"
  | "ambient-declaration"
  | "interface-member"
  | "abstract-method"
  | "overload-signature";

export interface MarkProblem {
  readonly kind: MarkProblemKind;
  readonly span: Span;
  /** Message parameters; `ineffective-mark` carries `site` and `line`. */
  readonly data: Readonly<Record<string, string>>;
}

export interface Marks {
  /**
   * The seeds, in source order. This is what the enforcement walk checks and
   * what the manifest emitter will scan: one whitelist, both consumers.
   */
  readonly bound: readonly ts.FunctionLikeDeclaration[];
  readonly problems: readonly MarkProblem[];
}

/**
 * Bind every `@nothrow` in a file, or say why it does not bind. A mark that
 * neither binds nor is reported would be a silent no-op, which is the one
 * outcome the design rules out.
 */
export function findMarks(sourceFile: ts.SourceFile): Marks {
  const problems: MarkProblem[] = [];
  // A function has one color however many times it is claimed, so a repeated
  // tag must not enforce — or emit — the same body twice.
  const bound = new Set<ts.FunctionLikeDeclaration>();

  for (const { tag, host } of nothrowTags(sourceFile)) {
    const target = bindingTarget(host);
    if (target === undefined) {
      problems.push(problemFor(host, spanOfTag(tag, sourceFile), sourceFile));
    } else {
      bound.add(target);
    }
  }

  return { bound: [...bound], problems };
}

/**
 * Whether a declaration is a bound seed: the same whitelist as `findMarks`,
 * asked one declaration at a time, which is what resolving a callee's color
 * needs. Both routes go through `bindingTarget`, so they cannot disagree.
 */
export function isMarkedFunction(declaration: ts.Node): boolean {
  const host = markHostOf(declaration);
  if (host === undefined) return false;
  return bindingTarget(host) === declaration && nothrowTagsOn(host).length > 0;
}

/** The construct a mark for this declaration would have to be written on. */
function markHostOf(declaration: ts.Node): ts.Node | undefined {
  if (canCarryBody(declaration)) return declaration;
  if (
    !ts.isFunctionExpression(declaration) &&
    !ts.isArrowFunction(declaration)
  ) {
    return undefined;
  }

  const { parent } = declaration;
  if (ts.isPropertyAssignment(parent)) return parent;
  if (!ts.isVariableDeclaration(parent)) return undefined;

  const statement = parent.parent.parent;
  return ts.isVariableStatement(statement) ? statement : undefined;
}

/**
 * Every `@nothrow` in the file, paired with the construct it directly precedes.
 */
function nothrowTags(
  sourceFile: ts.SourceFile,
): { tag: ts.JSDocTag; host: ts.Node }[] {
  const found: { tag: ts.JSDocTag; host: ts.Node }[] = [];

  const visit = (node: ts.Node): void => {
    if (carriesJSDoc(node, sourceFile)) {
      for (const tag of nothrowTagsOn(node)) found.push({ tag, host: node });
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
  return found;
}

/**
 * Attribution is the parser's lexical one — the node whose leading trivia the
 * comment sits in. `getJSDocTags`' climb to enclosing nodes is discarded, so
 * what a mark binds to is decided by `bindingTarget` and nowhere else.
 */
function nothrowTagsOn(host: ts.Node): ts.JSDocTag[] {
  return ts
    .getJSDocTags(host)
    .filter(
      (tag) =>
        tag.tagName.escapedText === "nothrow" && tag.parent.parent === host,
    );
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

/** The syntactic positions a mark may occupy. */
type ValidSite =
  | ts.FunctionDeclaration
  | ts.VariableStatement
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.PropertyAssignment;

/**
 * The construct a mark binds to, or nothing. A body is required throughout: a
 * mark is a claim about one, so the bodyless family is rejected rather than
 * trusted in your own source.
 */
function bindingTarget(host: ts.Node): ts.FunctionLikeDeclaration | undefined {
  if (canCarryBody(host)) return host.body === undefined ? undefined : host;

  if (ts.isVariableStatement(host)) {
    const declarations = host.declarationList.declarations;
    if (declarations.length !== 1) return undefined;
    return asFunction(declarations[0]?.initializer);
  }

  if (ts.isPropertyAssignment(host)) return asFunction(host.initializer);

  return undefined;
}

function isValidSite(node: ts.Node): node is ValidSite {
  return bindingTarget(node) !== undefined;
}

function asFunction(
  initializer: ts.Expression | undefined,
): ts.FunctionLikeDeclaration | undefined {
  if (initializer === undefined) return undefined;
  return ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)
    ? initializer
    : undefined;
}

function problemFor(
  host: ts.Node,
  span: Span,
  sourceFile: ts.SourceFile,
): MarkProblem {
  const kind = problemKind(host);
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
  return "ineffective-mark";
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

  const declaration = ts.isVariableStatement(site)
    ? site.declarationList.declarations[0]
    : site;
  const name =
    declaration === undefined
      ? undefined
      : ts.getNameOfDeclaration(declaration)?.getText(sourceFile);

  const noun = siteNoun(site);
  return name === undefined ? `the ${noun}` : `the ${noun} \`${name}\``;
}

function siteNoun(site: ValidSite): string {
  if (ts.isGetAccessorDeclaration(site)) return "getter";
  if (ts.isSetAccessorDeclaration(site)) return "setter";
  if (ts.isMethodDeclaration(site)) return "method";
  if (ts.isPropertyAssignment(site)) return "property";
  return "function";
}

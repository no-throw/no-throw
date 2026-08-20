import ts from "typescript";

/**
 * How an offered edit puts the escape site behind a bridge. The three shapes
 * are the three things a reader would actually type:
 *
 * - `wrap` — put a `try`/`catch` around the statement the site escapes from.
 * - `awaiting-wrap` — the same, and write the `await` the site is missing,
 *   because a `catch` with nothing awaited is not on the rejection's path.
 * - `await` — write only the `await`: the `try` is already there, and it is
 *   the missing `await` that makes it a bridge rather than a fake one.
 */
export type BridgeShape = "wrap" | "awaiting-wrap" | "await";

/**
 * A replacement, in source offsets. Offsets rather than nodes because that is
 * what every host's fixer takes, and it is the one currency two adapters over
 * two different syntax trees can both spend.
 */
export interface BridgeEdit {
  readonly range: readonly [number, number];
  readonly text: string;
}

/**
 * Statements a bridge can wrap and still leave the rest of the file saying
 * what it said. A declaration is not one: wrapping `const value = risky()`
 * takes the binding out of the scope that reads it, breaking code that has
 * nothing to do with the escape, and the only mechanical repair — wrapping
 * through the end of the block — would silence every other escape in it.
 *
 * Wrapping a `return` is a different thing, though it also leaves the reader
 * work: the bridge is complete, and what the compiler then asks for is the one
 * thing no tool can decide, which is what this function returns instead of
 * throwing. That is the `@nothrow` bargain being collected, not a broken edit.
 */
const WRAPPABLE: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.ReturnStatement,
  // Driving the iterator is what the loop *is*, so the loop is the site.
  ts.SyntaxKind.ForOfStatement,
]);

/** One level of indentation, in the edits this file writes. */
const STEP = "  ";

/**
 * The edit to offer for an escape at `node`, or nothing when the shape does
 * not fit here. Shaping an edit is not analysis: which color the site has was
 * settled before this is reached, and all that is decided here is where the
 * text goes.
 */
export function bridgeEdit(
  node: ts.Node,
  shape: BridgeShape,
  sourceFile: ts.SourceFile,
): BridgeEdit | undefined {
  // Only an `async` function can await, and turning one async changes its
  // signature and hands its rejection to every caller — not an edit anybody
  // can accept blind.
  if (shape !== "wrap" && !inAsyncFunction(node)) return undefined;

  // A shape with no `case` stops returning on every path, which is a compile
  // error. It has to: the way a missed shape would fail is by falling through
  // to the plain wrap, and a wrap where an `await` was wanted is the fake
  // bridge — a suggestion that reads as a bridge and neutralizes nothing.
  switch (shape) {
    case "await": {
      const start = node.getStart(sourceFile);
      return { range: [start, start], text: "await " };
    }
    case "wrap":
      return wrapStatementAround(node, false, sourceFile);
    case "awaiting-wrap":
      return wrapStatementAround(node, true, sourceFile);
  }
}

function wrapStatementAround(
  node: ts.Node,
  awaiting: boolean,
  sourceFile: ts.SourceFile,
): BridgeEdit | undefined {
  const enclosing = enclosingStatement(node);
  if (enclosing === undefined) return undefined;
  if (!WRAPPABLE.has(enclosing.statement.kind)) return undefined;

  return wrap(
    enclosing,
    awaiting ? node.getStart(sourceFile) : undefined,
    sourceFile,
  );
}

function wrap(
  { statement, braced }: EnclosingStatement,
  awaitAt: number | undefined,
  sourceFile: ts.SourceFile,
): BridgeEdit {
  const source = sourceFile.text;
  const start = statement.getStart(sourceFile);
  const end = statement.getEnd();
  const region =
    awaitAt === undefined
      ? source.slice(start, end)
      : `${source.slice(start, awaitAt)}await ${source.slice(awaitAt, end)}`;

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = indentationAt(source, start);
  // Braces the reader left out are braces the bridge writes, and they put the
  // `try` — and with it everything under it — one level further in.
  const { tryIndent, deeper } = braced
    ? { tryIndent: indent, deeper: STEP }
    : { tryIndent: `${indent}${STEP}`, deeper: `${STEP}${STEP}` };
  // The replacement starts where the statement did, so the first line is
  // already indented by the file and only the ones after it carry their own.
  const body = region
    .split(newline)
    .map((line, index) =>
      index === 0 ? `${indent}${deeper}${line}` : `${deeper}${line}`,
    )
    .join(newline);
  const bridge = `try {${newline}${body}${newline}${tryIndent}} catch {}`;

  return {
    range: [start, end],
    text: braced
      ? bridge
      : `{${newline}${tryIndent}${bridge}${newline}${indent}}`,
  };
}

/**
 * The indentation of the line the statement is on, which is not always what
 * precedes the statement — `case 1: risky();` puts one after the other.
 */
function indentationAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const line = source.slice(lineStart, offset);
  return /^\s*/.exec(line)?.[0] ?? "";
}

/** A statement position, and whether the braces around it are already there. */
interface EnclosingStatement {
  readonly statement: ts.Node;
  readonly braced: boolean;
}

/**
 * The statement the site escapes from — the smallest thing a `try` can go
 * around and still be on the path the escape takes.
 *
 * The walk stops at a function boundary, and that stop is the whole point: a
 * body reached through a callback runs when something calls it, which may be
 * long after this statement returns. A `try` out here would neutralize nothing
 * while looking as if it did, which is the fake bridge the rule exists to
 * report — so no host may suggest one.
 *
 * The color walk makes the same judgement about the same boundary, and the two
 * are not wired together. They cannot disagree dangerously: if it ever comes to
 * treat a boundary this walk refuses to cross as synchronous, the offer goes
 * missing rather than going wrong.
 */
function enclosingStatement(node: ts.Node): EnclosingStatement | undefined {
  let current: ts.Node = node;

  for (;;) {
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined) return undefined;
    if (statementListOf(parent)?.includes(current) === true)
      return { statement: current, braced: true };
    if (isHeldBody(parent, current))
      return { statement: current, braced: false };
    if (isFunction(parent)) return undefined;
    current = parent;
  }
}

/** Where a node is a statement rather than a part of one. */
function statementListOf(
  node: ts.Node | undefined,
): readonly ts.Node[] | undefined {
  if (node === undefined) return undefined;
  // A class's `static {}` block holds a `Block`, so it needs no case of its
  // own: the walk out of one meets that block's statement list first.
  if (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  ) {
    return node.statements;
  }
  return undefined;
}

/**
 * Whether `child` is the statement a branch or a loop holds on its own, which
 * is a statement position no less than a member of a block is — it is the same
 * statement, on the same synchronous path, written without braces. Nothing
 * about the escape turns on that, so nothing about the offer may either.
 *
 * A braced body never reaches here: the walk out of it meets the block's own
 * statement list first, which is what leaves this the unbraced case alone.
 */
function isHeldBody(parent: ts.Node, child: ts.Node): boolean {
  if (ts.isIfStatement(parent)) {
    return parent.thenStatement === child || parent.elseStatement === child;
  }
  if (
    ts.isDoStatement(parent) ||
    ts.isWhileStatement(parent) ||
    ts.isForStatement(parent) ||
    ts.isForInStatement(parent) ||
    // A `for…of` is an escape site in its own right, since driving the
    // iterator is what the loop *is*. That is the loop; this is the body
    // inside it, which the walk reaches first and wraps on its own.
    ts.isForOfStatement(parent)
  ) {
    return parent.statement === child;
  }
  // A label holds a statement too, and is left out anyway: braces there change
  // what the label denotes, and a label on a loop is a `continue` target, so
  // bracing its body turns every `continue` into a syntax error.
  //
  // `with` is left out for a different reason. TypeScript calls the statement
  // unsupported and gives every name in its body the type `any`, so the color
  // an offer there would endorse is one nothing read.
  return false;
}

/**
 * Whether an `await` written at this site would be legal. Module top level is
 * not counted: whether top-level await is available depends on the module
 * target, and an edit that only compiles under some of them is not mechanical.
 */
function inAsyncFunction(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (isFunction(current)) return isAsync(current);
  }
  return false;
}

/**
 * A body boundary. Every form is named rather than only the three ESTree calls
 * functions, because in this tree a method's body hangs off the method itself:
 * miss one and the walk climbs straight out of it, and a `try` written outside
 * a method around a site inside it is the fake bridge.
 */
function isFunction(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isAsync(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    )
  );
}

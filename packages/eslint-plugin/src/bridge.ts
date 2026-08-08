import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

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

/** A replacement, in source offsets — what a `RuleFix` is made of. */
export interface BridgeEdit {
  readonly range: TSESTree.Range;
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
const WRAPPABLE: ReadonlySet<string> = new Set<string>([
  AST_NODE_TYPES.ExpressionStatement,
  AST_NODE_TYPES.ReturnStatement,
  // Driving the iterator is what the loop *is*, so the loop is the site.
  AST_NODE_TYPES.ForOfStatement,
]);

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

/**
 * The edit to offer for an escape at `node`, or nothing when the shape does
 * not fit here. Shaping an edit is not analysis: which color the site has was
 * settled before this is reached, and all that is decided here is where the
 * text goes.
 */
export function bridgeEdit(
  node: TSESTree.Node,
  shape: BridgeShape,
  source: string,
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
    case "await":
      return { range: [node.range[0], node.range[0]], text: "await " };
    case "wrap":
      return wrapStatementAround(node, undefined, source);
    case "awaiting-wrap":
      return wrapStatementAround(node, node.range[0], source);
  }
}

function wrapStatementAround(
  node: TSESTree.Node,
  awaitAt: number | undefined,
  source: string,
): BridgeEdit | undefined {
  const statement = enclosingStatement(node);
  if (statement === undefined) return undefined;
  if (!WRAPPABLE.has(statement.type)) return undefined;

  return wrap(statement, awaitAt, source);
}

function wrap(
  statement: TSESTree.Node,
  awaitAt: number | undefined,
  source: string,
): BridgeEdit {
  const [start, end] = statement.range;
  const region =
    awaitAt === undefined
      ? source.slice(start, end)
      : `${source.slice(start, awaitAt)}await ${source.slice(awaitAt, end)}`;

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = indentationAt(source, start);
  // The replacement starts where the statement did, so the first line is
  // already indented by the file and only the ones after it carry their own.
  const body = region
    .split(newline)
    .map((line, index) => (index === 0 ? `${indent}  ${line}` : `  ${line}`))
    .join(newline);

  return {
    range: statement.range,
    text: `try {${newline}${body}${newline}${indent}} catch {}`,
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

/**
 * The statement the site escapes from — the smallest thing a `try` can go
 * around and still be on the path the escape takes.
 *
 * The walk stops at a function boundary, and that stop is the whole point: a
 * body reached through a callback runs when something calls it, which may be
 * long after this statement returns. A `try` out here would neutralize nothing
 * while looking as if it did, which is the fake bridge the rule exists to
 * report — so the plugin must not suggest one.
 *
 * The core makes the same judgement about the same boundary, and the two are
 * not wired together. They cannot disagree dangerously: if the core ever comes
 * to treat a boundary this walk refuses to cross as synchronous, the offer
 * goes missing rather than going wrong.
 */
function enclosingStatement(node: TSESTree.Node): TSESTree.Node | undefined {
  let current: TSESTree.Node = node;

  for (;;) {
    const parent: TSESTree.Node | undefined = current.parent;
    if (parent === undefined) return undefined;
    if (statementListOf(parent)?.includes(current) === true) return current;
    if (isFunction(parent)) return undefined;
    current = parent;
  }
}

/** Where a node is a statement rather than a part of one. */
function statementListOf(
  node: TSESTree.Node,
): readonly TSESTree.Node[] | undefined {
  switch (node.type) {
    case AST_NODE_TYPES.Program:
    case AST_NODE_TYPES.BlockStatement:
    case AST_NODE_TYPES.StaticBlock:
    case AST_NODE_TYPES.TSModuleBlock:
      return node.body;
    case AST_NODE_TYPES.SwitchCase:
      return node.consequent;
    default:
      return undefined;
  }
}

/**
 * Whether an `await` written at this site would be legal. Module top level is
 * not counted: whether top-level await is available depends on the module
 * target, and an edit that only compiles under some of them is not mechanical.
 */
function inAsyncFunction(node: TSESTree.Node): boolean {
  for (
    let current: TSESTree.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (isFunction(current)) return current.async;
  }
  return false;
}

function isFunction(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.FunctionExpression
  );
}

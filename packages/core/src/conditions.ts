import ts from "typescript";
import type { Requirement } from "./baseline/paths.js";
import type { Bodied } from "./declarations.js";
import type { Transfer } from "./escapes.js";

/**
 * An access path over one function's own parameters — a condition path in the
 * engine's own terms, spelled `param1.save` on the wire. Positions cannot reach
 * past depth 0 and there is no principle behind that cutoff: the checker
 * resolves `repo.save` to a symbol, so a condition follows the member rather
 * than stopping at the argument.
 *
 * The derivation only ever produces member segments, so the wire grammar's
 * `[]` and `.@@name` have no engine form yet; a callee reached through either
 * floors.
 */
export interface ParameterPath {
  readonly paramIndex: number;
  readonly members: readonly string[];
}

/**
 * A precondition on one function about the argument at `path`. `requires` says
 * which: `entered` is the ordinary reading — the owner enters the path, so
 * whatever reaches it has to be non-throwing — and `nullish` is the one only a
 * carrier can state, that the owner is clean given nothing reaches the position
 * at all.
 *
 * `entry` is where the owner's own body transfers control through the path,
 * which the discharge diagnostic has to name — for a propagated condition that
 * is the site the owner hands the parameter on at, so the parameter named and
 * the line pointed at are always the same function.
 *
 * A condition a carrier states has no entry: there is no body, and the line a
 * `.d.ts` declares the symbol on enters nothing. The diagnostic names the
 * carrier instead. A `nullish` condition never has one for a second reason —
 * the whole claim is that no body is entered.
 */
export interface Condition {
  readonly requires: Requirement;
  readonly path: ParameterPath;
  readonly owner: Bodied;
  readonly entry: Transfer | undefined;
}

/**
 * How deep a path may go. Propagation appends the callee's segments to the
 * caller's, so a cycle passing members onward could grow one forever; this is
 * the lattice's finite height made concrete, and a path that would exceed it
 * floors — over-strict, never a lie.
 */
export const MAX_CONDITION_DEPTH = 4;

/**
 * The parameters a path can be rooted at. A class stands for a constructor it
 * does not declare, and that constructor's parameters are not written anywhere
 * — nothing its field initializers can reach names one.
 */
export function parametersOf(body: Bodied): readonly ts.ParameterDeclaration[] {
  return ts.isClassLike(body) ? [] : body.parameters;
}

/** Identity for a path: two conditions on the same path are one condition. */
export function pathKey(path: ParameterPath): string {
  return [`param${path.paramIndex}`, ...path.members].join(".");
}

/**
 * Identity for a condition. Two requirements on one position are two
 * conditions, so the path alone does not identify one: `param0` and
 * `param0=nullish` are answered by different questions about the same argument.
 */
export function conditionKey(condition: Condition): string {
  return `${condition.requires} ${pathKey(condition.path)}`;
}

/**
 * The path as the author wrote it — `cb`, `repo.save` — since a diagnostic
 * naming `param1` would send them counting parameters.
 */
export function describePath(path: ParameterPath, owner: Bodied): string {
  const parameter = parametersOf(owner)[path.paramIndex];
  const name =
    parameter !== undefined && ts.isIdentifier(parameter.name)
      ? parameter.name.text
      : `param${path.paramIndex}`;
  return [name, ...path.members].join(".");
}

/** Whose parameter an access chain is rooted at, from `body`'s point of view. */
export type ParameterRoot =
  | "own"
  /**
   * An enclosing function's parameter. A condition can only be a path over the
   * function's own parameters, so nothing at any call site could discharge it.
   */
  | "captured"
  | "other";

export function parameterRoot(
  expr: ts.Expression,
  body: Bodied,
  checker: ts.TypeChecker,
): ParameterRoot {
  const parameter = rootParameter(expr, checker);
  if (parameter === undefined) return "other";
  // The body walk never crosses a function boundary, so a parameter reachable
  // from here that is not ours belongs to a function enclosing this one.
  return parametersOf(body).indexOf(parameter) === -1 ? "captured" : "own";
}

/**
 * The path an access chain names over `body`'s parameters, or nothing where
 * there is none to name. A member that resolves to no symbol — the `any` case
 * — is not a path: with nothing to condition on, the floor is the answer.
 */
export function pathOf(
  expr: ts.Expression,
  body: Bodied,
  checker: ts.TypeChecker,
): ParameterPath | undefined {
  const parameter = rootParameter(expr, checker);
  if (parameter === undefined) return undefined;

  const paramIndex = parametersOf(body).indexOf(parameter);
  if (paramIndex === -1) return undefined;

  const members: string[] = [];
  for (const access of accessChain(expr)) {
    if (checker.getSymbolAtLocation(access.name) === undefined) return undefined;
    members.push(access.name.text);
  }

  return { paramIndex, members };
}

export function skipParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function rootParameter(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): ts.ParameterDeclaration | undefined {
  let current = skipParens(expr);
  while (ts.isPropertyAccessExpression(current)) {
    current = skipParens(current.expression);
  }
  if (!ts.isIdentifier(current)) return undefined;

  const declaration = checker.getSymbolAtLocation(current)?.valueDeclaration;
  return declaration !== undefined && ts.isParameter(declaration)
    ? declaration
    : undefined;
}

/** The property accesses of a chain, outermost last. */
function accessChain(expr: ts.Expression): ts.PropertyAccessExpression[] {
  const chain: ts.PropertyAccessExpression[] = [];
  let current = skipParens(expr);
  while (ts.isPropertyAccessExpression(current)) {
    chain.unshift(current);
    current = skipParens(current.expression);
  }
  return chain;
}

import ts from "typescript";
import { skipParens } from "./conditions.js";
import {
  bodyOf,
  classEvaluation,
  fieldInitializers,
  type Bodied,
} from "./declarations.js";
import { iterationEscapeAt, type IterationEscape } from "./iteration.js";
import { discardedExpression } from "./promises.js";

/**
 * A site that transfers control into some other body, with the syntax naming
 * the callee. Each takes that callee's color and each is bridgeable.
 */
export type Transfer =
  | ts.CallExpression
  | ts.NewExpression
  | ts.TaggedTemplateExpression;

/** A member access, whichever way the key is written. */
export type AccessExpression =
  | ts.PropertyAccessExpression
  | ts.ElementAccessExpression;

/**
 * One element of a value being taken apart — by a binding pattern, or by an
 * object literal standing in assignment position. Each reads one member off the
 * source, or, for a rest element, all of its own enumerable ones.
 */
export type DestructuringElement =
  | ts.BindingElement
  | ts.PropertyAssignment
  | ts.ShorthandPropertyAssignment
  | ts.SpreadAssignment;

/**
 * A site that transfers control out of the body it is written in. `throw` and
 * `call` name what runs in the syntax. The rest are *hidden* transfers: a body
 * runs with no callee written down, and only the static type can say which — so
 * the walk yields the candidate and the resolver decides whether anything runs
 * at all. That split keeps this walk free of the checker, and keeps every
 * question about types on the one seam that answers them.
 *
 * The iteration protocol's sites are hidden in the same way, and hidden twice
 * over: the body they run is one some earlier call only *produced*.
 */
export type Escape =
  | { readonly kind: "throw"; readonly node: ts.ThrowStatement }
  | { readonly kind: "call"; readonly node: Transfer }
  | {
      readonly kind: "read" | "write" | "update";
      readonly node: AccessExpression;
    }
  | { readonly kind: "destructure"; readonly node: DestructuringElement }
  | { readonly kind: "spread"; readonly node: ts.SpreadAssignment }
  | { readonly kind: "coercion"; readonly node: ts.Expression }
  | { readonly kind: "instance-check"; readonly node: ts.BinaryExpression }
  /** Where a promise's rejection is consumed, and so where it can escape. */
  | { readonly kind: "await"; readonly node: ts.AwaitExpression }
  /**
   * A promise dropped in statement position. It is the one escape a `try`
   * neutralizes nothing about — a rejection is not on the path a `catch`
   * without an `await` sits on — so the walk carries the bridge it was written
   * inside rather than filtering it out, and the fake bridge is what that
   * combination is called.
   */
  | {
      readonly kind: "float";
      readonly node: ts.Expression;
      readonly bridged: boolean;
    }
  | IterationEscape;

/**
 * Which of a call's work is being looked at. For every function kind but one
 * the answer is "all of it"; a generator's call runs its parameter list and
 * nothing else, and its body runs at the consumption sites instead.
 */
export type Phase = "all" | "eager" | "lazy";

/**
 * The expression naming the callee, wherever the transfer's syntax keeps it.
 * Reading it in one place is what keeps every site that wants to name what is
 * being entered from having to remember the tag/expression difference.
 */
export function calleeExpression(transfer: Transfer): ts.Expression {
  return ts.isTaggedTemplateExpression(transfer)
    ? transfer.tag
    : transfer.expression;
}

/**
 * Every escape site in a body, minus the ones a bridge neutralizes. One walk
 * serves both consumers: enforcement reports the sites whose callee is
 * throwing, and inference reads the same sites as the edges of the call graph —
 * so the two can never disagree about what a body does.
 */
export function unbridgedEscapes(
  declaration: Bodied,
  checker: ts.TypeChecker,
  phase: Phase = "all",
): readonly Escape[] {
  const found: Escape[] = [];

  const walk = (node: ts.Node, region: ts.Node): void => {
    const bridged = isBridged(node, region);
    if (ts.isExpressionStatement(node)) {
      found.push({
        kind: "float",
        node: discardedExpression(node.expression),
        bridged,
      });
    } else if (!bridged) {
      found.push(...escapesAt(node, checker));
    }

    node.forEachChild((child) => {
      // A nested function is its own body with its own color.
      if (ts.isFunctionLike(child)) return;
      // A class is two things at once. Its member bodies and instance field
      // initializers run on construction, and `new C()` is the escape site
      // that reaches them. Everything else about it runs right here, where the
      // class is written — so it stays in this region and is bridged by
      // whatever bridges the rest of it.
      if (ts.isClassLike(child)) {
        for (const evaluated of classEvaluation(child)) walk(evaluated, region);
        return;
      }
      walk(child, region);
    });
  };

  for (const region of regionsOf(declaration, phase)) walk(region, region);
  return found;
}

/**
 * The source a call to this declaration runs. A parameter list is eager however
 * lazy the body is — a generator evaluates its defaults before it builds an
 * iterator — and a constructor's effective body reaches the class's field
 * initializers, which are constructor body rather than an escape kind of their
 * own. Both are walked alongside the body itself, so this is one rule with no
 * special case per function kind: only *which* of the two halves is asked for
 * ever differs.
 */
function regionsOf(declaration: Bodied, phase: Phase): readonly ts.Node[] {
  if (ts.isClassLike(declaration)) {
    return phase === "eager" ? [] : fieldInitializers(declaration);
  }

  const regions: ts.Node[] = [];

  if (phase !== "lazy") {
    for (const parameter of declaration.parameters) {
      // A binding pattern carries defaults of its own, and they are eager too.
      regions.push(parameter.name);
      if (parameter.initializer !== undefined) {
        regions.push(parameter.initializer);
      }
    }
  }

  if (phase !== "eager") {
    if (ts.isConstructorDeclaration(declaration)) {
      regions.push(...fieldInitializers(declaration.parent));
    }
    const body = bodyOf(declaration);
    if (body !== undefined) regions.push(body);
  }

  return regions;
}

/**
 * One node can be two sites at once: in `o.x += 1` the access runs an accessor
 * pair and the value it yields is coerced, and those are different bodies.
 */
function escapesAt(
  node: ts.Node,
  checker: ts.TypeChecker,
): readonly Escape[] {
  if (ts.isThrowStatement(node)) return [{ kind: "throw", node }];

  const found: Escape[] = [];

  // The iteration protocol claims a call before the call rule does: `it.next()`
  // enters a body the syntax does not name, and its own declaration — the
  // standard library's `Generator` — is not the one that runs.
  const iterating = iterationEscapeAt(node, checker);
  if (iterating !== undefined) {
    found.push(iterating);
  } else if (isTransfer(node)) {
    found.push({ kind: "call", node });
  } else if (isAccessExpression(node)) {
    const kind = accessKindOf(node);
    if (kind !== undefined) found.push({ kind, node });
  } else if (isDestructuringElement(node)) {
    found.push({ kind: "destructure", node });
  } else if (ts.isSpreadAssignment(node)) {
    found.push({ kind: "spread", node });
  } else if (isInstanceCheck(node)) {
    found.push({ kind: "instance-check", node });
  } else if (ts.isAwaitExpression(node) && !isConsuming(node.expression, checker)) {
    // Awaiting `it.next()` is one site, not two: the iteration seam already
    // owns what the call enters, and the promise it hands back is that same
    // body's answer.
    found.push({ kind: "await", node });
  }

  if (ts.isExpression(node) && isCoerced(node)) {
    found.push({ kind: "coercion", node });
  }

  return found;
}

/**
 * A `try` with a `catch` neutralizes escapes originating in its try block only;
 * `catch` and `finally` blocks are ordinary body code.
 *
 * Neutralization is bounded by the region the escape was reached through, which
 * is what makes the rule right on both sides of a class: a `try` around a class
 * declaration does bridge the class's static initializers, because those run
 * there, and does not bridge its instance field initializers, because those run
 * wherever someone writes `new C()`. A function boundary needs no test — the
 * walk never crosses one, so no region spans it.
 */
function isBridged(node: ts.Node, region: ts.Node): boolean {
  let child: ts.Node = node;

  while (child !== region) {
    const parent: ts.Node | undefined = child.parent;
    if (parent === undefined) return false;
    if (
      ts.isTryStatement(parent) &&
      parent.catchClause !== undefined &&
      parent.tryBlock === child
    ) {
      return true;
    }
    child = parent;
  }

  return false;
}

/** Whether the iteration seam already claims this expression. */
function isConsuming(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return iterationEscapeAt(skipParens(expression), checker) !== undefined;
}

function isTransfer(node: ts.Node): node is Transfer {
  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  );
}

function isAccessExpression(node: ts.Node): node is AccessExpression {
  return (
    ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
  );
}

function isInstanceCheck(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
  );
}

/**
 * How the surrounding syntax uses the member, which is what decides the half of
 * an accessor pair it consults. The table is normative: get and set carry
 * independent colors, so reading a member that is only guarded on write must
 * not require the bridge that writing it does.
 */
function accessKindOf(
  access: AccessExpression,
): "read" | "write" | "update" | undefined {
  // `delete o.x` invokes neither half.
  if (ts.isDeleteExpression(access.parent)) return undefined;
  if (isUpdated(access)) return "update";
  return isWriteTarget(access) ? "write" : "read";
}

/** A read followed by a write of the same member: `+=`, `++`, `??=`. */
function isUpdated(access: AccessExpression): boolean {
  const { parent } = access;
  if (
    ts.isPrefixUnaryExpression(parent) ||
    ts.isPostfixUnaryExpression(parent)
  ) {
    return (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken
    );
  }
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === access &&
    COMPOUND_ASSIGNMENT.has(parent.operatorToken.kind)
  );
}

/**
 * Whether an expression is being assigned *to*, through however many layers of
 * destructuring pattern written as a literal. Missing one of those layers would
 * consult get where the runtime consults set, which is the unsound direction.
 */
function isWriteTarget(node: ts.Node): boolean {
  let child = node;

  for (
    let parent: ts.Node | undefined = child.parent;
    parent !== undefined;
    child = parent, parent = parent.parent
  ) {
    if (ts.isBinaryExpression(parent)) {
      return (
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === child
      );
    }
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      return parent.initializer === child;
    }
    if (!isPatternHop(parent, child)) return false;
  }

  return false;
}

/**
 * A step up out of a destructuring pattern towards whatever assigns to it. A
 * shorthand property is deliberately not one: the only expression it can hold
 * is a default (`({ x = o.y } = src)`), which is *read* when the source has no
 * value for it.
 */
function isPatternHop(parent: ts.Node, child: ts.Node): boolean {
  if (
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent)
  ) {
    return true;
  }
  return ts.isPropertyAssignment(parent) && parent.initializer === child;
}

function isDestructuringElement(node: ts.Node): node is DestructuringElement {
  if (ts.isBindingElement(node)) return ts.isObjectBindingPattern(node.parent);
  if (
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isSpreadAssignment(node)
  ) {
    return (
      ts.isObjectLiteralExpression(node.parent) && isWriteTarget(node.parent)
    );
  }
  return false;
}

/**
 * The operators that apply ToPrimitive, ToNumber or ToString to an operand, and
 * so can reach a conversion member. `===`, `!==`, `&&`, `||`, `??` and `!` are
 * deliberately absent: none of them can run user code.
 */
const COERCING_UNARY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.TildeToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
]);

/** The compound assignments built from a coercing operator. */
const COERCING_ASSIGNMENT: readonly ts.SyntaxKind[] = [
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
];

const COERCING_BINARY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ...COERCING_ASSIGNMENT,
]);

/** Every assignment operator but `=`: each reads the target before writing. */
const COMPOUND_ASSIGNMENT: ReadonlySet<ts.SyntaxKind> = new Set([
  ...COERCING_ASSIGNMENT,
  // The logical assignments write the target without coercing anything.
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function isCoerced(node: ts.Expression): boolean {
  const { parent } = node;

  if (ts.isTemplateSpan(parent)) {
    // A tagged template hands its substitutions to the tag uncoerced.
    return !ts.isTaggedTemplateExpression(parent.parent.parent);
  }
  // A computed key runs ToPropertyKey, which reaches `toString` like any other
  // conversion — `o[k]` and `{ [k]: v }` alike.
  if (ts.isElementAccessExpression(parent)) {
    return parent.argumentExpression === node;
  }
  if (ts.isComputedPropertyName(parent)) return true;
  if (
    ts.isPrefixUnaryExpression(parent) ||
    ts.isPostfixUnaryExpression(parent)
  ) {
    return COERCING_UNARY.has(parent.operator);
  }
  if (!ts.isBinaryExpression(parent)) return false;
  // `in` applies ToPropertyKey to its left operand and nothing to its right.
  if (parent.operatorToken.kind === ts.SyntaxKind.InKeyword) {
    return parent.left === node;
  }
  return COERCING_BINARY.has(parent.operatorToken.kind);
}

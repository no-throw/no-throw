import ts from "typescript";
import { libTargetOfFileName, memberKey } from "./baseline/keys.js";
import type {
  AccessExpression,
  DestructuringElement,
  Escape,
} from "./escapes.js";

/** How a hidden transfer reads in a diagnostic: the verb the site is. */
export type TransferSite =
  | "read"
  | "write"
  | "update"
  | "destructure"
  | "spread"
  | "coercion"
  | "instance-check";

/** The body a site enters, named the way the source spells it. */
export interface HiddenCallee {
  readonly kind: "getter" | "setter" | "method";
  readonly name: string;
}

export interface TransferTarget {
  /** Absent when the type cannot even name what runs. */
  readonly target: HiddenCallee | undefined;
  /** The body to read a color off, or absent when there is none. */
  readonly declaration: ts.SignatureDeclaration | undefined;
}

/**
 * A hidden call site: where to report it, how to describe it, and every body it
 * can enter. The set is *joined* — the site is throwing if any member of it is
 * — which is what a dynamic key, a spread and a coercion each need, and what
 * lets `bytes[i]` come out clean because all four of its accessors are.
 */
export interface Transfer {
  readonly node: ts.Node;
  readonly site: TransferSite;
  /** The expression as written, so a message can name it. */
  readonly text: string;
  readonly targets: readonly TransferTarget[];
}

/** Which half of an accessor pair a site consults. */
type Half = "get" | "set" | "both";

/**
 * The hidden transfers at one escape site, resolved through the static type.
 *
 * The chain that answers "is this member really an accessor?" is the
 * *declaration* plus the sound floor for opaque members. Overlay, shipped
 * manifest and baseline rungs slot in behind this same call, which is why the
 * question is asked here rather than in the walk.
 */
export function hiddenTransfersOf(
  escape: Escape,
  checker: ts.TypeChecker,
): readonly Transfer[] {
  switch (escape.kind) {
    case "throw":
      return [];
    case "call":
      // Only a call signature is keyed below; `new String(o)` and a tagged
      // template resolve to different members of the same lib interfaces.
      return ts.isCallExpression(escape.node)
        ? callTransfers(escape.node, checker)
        : [];
    case "read":
    case "write":
    case "update":
      return accessTransfers(escape.node, escape.kind, checker);
    case "destructure":
      return destructuringTransfers(escape.node, checker);
    case "spread":
      return spreadTransfers(escape.node, escape.node.expression, checker);
    case "coercion":
      return coercionTransfers(escape.node, checker);
    case "instance-check":
      return instanceCheckTransfers(escape.node, checker);
  }
}

/** The expression as written, collapsed onto one line for a message. */
export function textOf(node: ts.Node): string {
  return node.getText().replace(/\s+/gu, " ");
}

/** `any` and `unknown` say nothing about what runs, so they cannot be read. */
const OPAQUE_TYPE = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

/** Types that run no user code when coerced. */
const PRIMITIVE_TYPE =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void |
  ts.TypeFlags.Never;

function accessTransfers(
  node: AccessExpression,
  site: "read" | "write" | "update",
  checker: ts.TypeChecker,
): readonly Transfer[] {
  const text = textOf(node);
  const receiver = receiverType(node.expression, checker);
  if (receiver === undefined) return [unnameable(node, site, text)];

  const half: Half =
    site === "read" ? "get" : site === "write" ? "set" : "both";
  const targets = ts.isPropertyAccessExpression(node)
    ? namedMemberTargets(node, half, checker)
    : keyedMemberTargets(receiver, node.argumentExpression, half, checker);

  return targets.length === 0 ? [] : [{ node, site, text, targets }];
}

/**
 * A property access whose symbol the checker cannot produce resolves through an
 * index signature, and an index signature can only ever declare data: an
 * accessor has to be written out as a member to exist.
 */
function namedMemberTargets(
  node: ts.PropertyAccessExpression,
  half: Half,
  checker: ts.TypeChecker,
): readonly TransferTarget[] {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol === undefined ? [] : accessorTargets(symbol, half);
}

/**
 * Narrow, then join: if every constituent of the key's type is a string
 * literal, exactly those members are touched; otherwise every accessor the type
 * has is. The fallback is what already works — narrowing is precision on top.
 */
function keyedMemberTargets(
  receiver: ts.Type,
  key: ts.Expression,
  half: Half,
  checker: ts.TypeChecker,
): readonly TransferTarget[] {
  const names = narrowKey(key, checker);
  const symbols =
    names === undefined
      ? membersOf(receiver, checker)
      : names.flatMap((name) => memberNamed(receiver, name, checker));
  return symbols.flatMap((symbol) => accessorTargets(symbol, half));
}

function narrowKey(
  key: ts.Expression,
  checker: ts.TypeChecker,
): readonly string[] | undefined {
  const type = checker.getTypeAtLocation(key);
  const names: string[] = [];

  for (const part of constituentsOf(type)) {
    if (!part.isStringLiteral()) return undefined;
    names.push(part.value);
  }

  return names;
}

function accessorTargets(
  symbol: ts.Symbol,
  half: Half,
): readonly TransferTarget[] {
  const targets: TransferTarget[] = [];

  for (const declaration of symbol.declarations ?? []) {
    if (half !== "set" && ts.isGetAccessorDeclaration(declaration)) {
      targets.push({
        target: { kind: "getter", name: memberName(symbol) },
        declaration,
      });
    }
    if (half !== "get" && ts.isSetAccessorDeclaration(declaration)) {
      targets.push({
        target: { kind: "setter", name: memberName(symbol) },
        declaration,
      });
    }
  }

  return targets;
}

function destructuringTransfers(
  node: DestructuringElement,
  checker: ts.TypeChecker,
): readonly Transfer[] {
  const text = textOf(node);
  const targets = ts.isBindingElement(node)
    ? bindingTargets(node, checker)
    : assignmentTargets(node, checker);

  if (targets === undefined) return [unnameable(node, "destructure", text)];
  return targets.length === 0
    ? []
    : [{ node, site: "destructure", text, targets }];
}

/** `undefined` where the source type cannot be read: the caller floors. */
function bindingTargets(
  element: ts.BindingElement,
  checker: ts.TypeChecker,
): readonly TransferTarget[] | undefined {
  const source = receiverType(element.parent, checker);
  if (source === undefined) return undefined;
  if (element.dotDotDotToken !== undefined) {
    return ownEnumerableTargets(source, checker);
  }

  const name = element.propertyName ?? element.name;
  if (ts.isComputedPropertyName(name)) {
    return keyedMemberTargets(source, name.expression, "get", checker);
  }
  if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
    // Only reachable with a property name, which the branch above took.
    return [];
  }

  return memberNamed(source, name.text, checker).flatMap((symbol) =>
    accessorTargets(symbol, "get"),
  );
}

/**
 * A destructuring assignment reads its source exactly as a binding pattern
 * does, but the pattern is spelled as an object literal whose own type says
 * nothing about where the values come from. The checker answers the named case
 * directly; the rest floors.
 */
function assignmentTargets(
  element: Exclude<DestructuringElement, ts.BindingElement>,
  checker: ts.TypeChecker,
): readonly TransferTarget[] | undefined {
  if (ts.isSpreadAssignment(element)) {
    const source = assignedSource(element.parent, checker);
    return source === undefined
      ? undefined
      : ownEnumerableTargets(source, checker);
  }

  const { name } = element;
  if (!ts.isIdentifier(name)) return undefined;
  const symbol = checker.getPropertySymbolOfDestructuringAssignment(name);
  return symbol === undefined ? [] : accessorTargets(symbol, "get");
}

/** The value a destructuring pattern is assigned, where the syntax says. */
function assignedSource(
  pattern: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const { parent } = pattern;
  if (
    !ts.isBinaryExpression(parent) ||
    parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    parent.left !== pattern
  ) {
    return undefined;
  }
  return receiverType(parent.right, checker);
}

function spreadTransfers(
  node: ts.Node,
  source: ts.Expression,
  checker: ts.TypeChecker,
): readonly Transfer[] {
  const text = textOf(source);
  const type = receiverType(source, checker);
  if (type === undefined) return [unnameable(node, "spread", text)];

  const targets = ownEnumerableTargets(type, checker);
  return targets.length === 0 ? [] : [{ node, site: "spread", text, targets }];
}

function ownEnumerableTargets(
  source: ts.Type,
  checker: ts.TypeChecker,
): readonly TransferTarget[] {
  return membersOf(source, checker).flatMap((symbol) =>
    (symbol.declarations ?? [])
      .filter(mayBeOwnGetAccessor)
      .map((declaration) => ({
        target: { kind: "getter" as const, name: memberName(symbol) },
        declaration,
      })),
  );
}

/**
 * A get accessor written in a class body and not `static` is on the prototype,
 * so an instance does not own it — which is why spreading a DOM element touches
 * nothing. That is the one case where own-ness has an answer: an accessor
 * declared on an interface or a type literal could describe either an object
 * literal or a class instance, and the sound reading of that is that it is own.
 */
function mayBeOwnGetAccessor(
  declaration: ts.Declaration,
): declaration is ts.GetAccessorDeclaration {
  if (!ts.isGetAccessorDeclaration(declaration)) return false;
  return (
    !ts.isClassLike(declaration.parent) ||
    (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) !== 0
  );
}

function coercionTransfers(
  value: ts.Expression,
  checker: ts.TypeChecker,
): readonly Transfer[] {
  const text = textOf(value);
  const type = checker.getTypeAtLocation(value);
  if ((type.flags & OPAQUE_TYPE) !== 0) {
    return [unnameable(value, "coercion", text)];
  }
  if (isPrimitive(type)) return [];
  // A type parameter is not itself a primitive, but a constraint that is bounds
  // every value it can hold — so `${k}` on `K extends string` costs nothing.
  const constraint = checker.getBaseConstraintOfType(type);
  if (constraint !== undefined && isPrimitive(constraint)) return [];

  // `ToPrimitive` tries all three in turn, and which of them stops depends on
  // the hint and on what each returns — neither of which is static.
  const targets = [
    ...declaredWellKnownTargets(type, "toPrimitive", checker),
    ...inheritedMethodTargets(type, "valueOf", checker),
    ...inheritedMethodTargets(type, "toString", checker),
  ];

  // A type with no conversion member at all cannot be coerced without a
  // TypeError, and nothing here can say otherwise.
  return [
    {
      node: value,
      site: "coercion",
      text,
      targets: targets.length === 0 ? [UNNAMEABLE] : targets,
    },
  ];
}

function instanceCheckTransfers(
  node: ts.BinaryExpression,
  checker: ts.TypeChecker,
): readonly Transfer[] {
  const text = textOf(node);
  const constructor = checker.getTypeAtLocation(node.right);
  if ((constructor.flags & OPAQUE_TYPE) !== 0) {
    return [unnameable(node, "instance-check", text)];
  }

  // Only a declared `Symbol.hasInstance` is consulted. Inheriting
  // `Function.prototype`'s runs `OrdinaryHasInstance`, which reads a data
  // property and walks the prototype chain — it reaches no user code at all,
  // unlike the `valueOf`/`toString` a coercion inherits.
  const targets = declaredWellKnownTargets(constructor, "hasInstance", checker);
  return targets.length === 0
    ? []
    : [{ node, site: "instance-check", text, targets }];
}

/**
 * The lib members whose *arguments* are hidden transfers: `String` and `Number`
 * coerce theirs, and `Object.assign` reads each source's own enumerable members
 * exactly as spread does. They are matched by the name the libs declare them
 * under — the one place a name is not the author's to choose.
 */
function callTransfers(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): readonly Transfer[] {
  const callee = libCalleeKey(call, checker);
  if (callee === "ObjectConstructor#assign") {
    return call.arguments.slice(1).flatMap((source) =>
      // A spread argument's sources are the elements of whatever it spreads,
      // and the syntax names none of them.
      ts.isSpreadElement(source)
        ? [unnameable(source, "spread", textOf(source))]
        : spreadTransfers(source, source, checker),
    );
  }
  if (callee !== "StringConstructor#()" && callee !== "NumberConstructor#()") {
    return [];
  }
  const [value] = call.arguments;
  return value === undefined ? [] : coercionTransfers(value, checker);
}

function libCalleeKey(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): string | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (
    declaration === undefined ||
    libTargetOfFileName(declaration.getSourceFile().fileName) === undefined
  ) {
    return undefined;
  }

  const owner = declaration.parent;
  if (!ts.isInterfaceDeclaration(owner)) return undefined;
  const name = ts.isCallSignatureDeclaration(declaration)
    ? "()"
    : ts.getNameOfDeclaration(declaration)?.getText();
  return name === undefined ? undefined : memberKey(owner.name.text, name);
}

/**
 * A member the type or one of its declared bases carries. `Object.prototype`'s
 * are deliberately out of reach: a type *declaring* its own conversion member
 * takes that member's color, while inheriting only the builtin is the
 * baseline's to answer.
 */
function declaredWellKnownTargets(
  type: ts.Type,
  name: string,
  checker: ts.TypeChecker,
): readonly TransferTarget[] {
  const symbols = membersOf(checker.getApparentType(type), checker).filter(
    (symbol) => wellKnownName(symbol) === name,
  );
  return symbols.flatMap((symbol) => methodTargets(symbol));
}

/** A member as an ordinary lookup sees it, `Object.prototype`'s included. */
function inheritedMethodTargets(
  type: ts.Type,
  name: string,
  checker: ts.TypeChecker,
): readonly TransferTarget[] {
  return memberNamed(checker.getApparentType(type), name, checker).flatMap(
    (symbol) => methodTargets(symbol),
  );
}

function methodTargets(symbol: ts.Symbol): readonly TransferTarget[] {
  const target: HiddenCallee = { kind: "method", name: memberName(symbol) };
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return [{ target, declaration: undefined }];

  return declarations.map((declaration) => ({
    target,
    // A conversion member declared as data — `toString: () => string` — names
    // no body to read a color off.
    declaration: ts.isFunctionLike(declaration) ? declaration : undefined,
  }));
}

/**
 * Every member a value may have. `getPropertiesOfType` answers a union with
 * only what *every* constituent has, which is the wrong direction: a member one
 * constituent declares still runs when the value is that constituent.
 */
function membersOf(
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly ts.Symbol[] {
  if (!type.isUnion()) return checker.getPropertiesOfType(type);
  return type.types.flatMap((part) =>
    checker.getPropertiesOfType(checker.getApparentType(part)),
  );
}

/** One named member, across a union's constituents, inherited ones included. */
function memberNamed(
  type: ts.Type,
  name: string,
  checker: ts.TypeChecker,
): readonly ts.Symbol[] {
  if (!type.isUnion()) {
    const symbol = checker.getPropertyOfType(type, name);
    return symbol === undefined ? [] : [symbol];
  }
  return type.types.flatMap((part) =>
    memberNamed(checker.getApparentType(part), name, checker),
  );
}

/** The apparent type of a receiver, or nothing when it cannot be read. */
function receiverType(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const type = checker.getApparentType(checker.getTypeAtLocation(node));
  return (type.flags & OPAQUE_TYPE) === 0 ? type : undefined;
}

function constituentsOf(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

function isPrimitive(type: ts.Type): boolean {
  return constituentsOf(type).every(
    (part) => (part.flags & PRIMITIVE_TYPE) !== 0,
  );
}

/**
 * TypeScript spells a well-known symbol member `__@toPrimitive@<id>`, where the
 * id belongs to that program's `Symbol` declaration — so the name can only be
 * matched, never written down.
 */
const WELL_KNOWN_MEMBER = /^__@(\w+)@\d+$/u;

function wellKnownName(symbol: ts.Symbol): string | undefined {
  return WELL_KNOWN_MEMBER.exec(symbol.getName())?.[1];
}

function memberName(symbol: ts.Symbol): string {
  const wellKnown = wellKnownName(symbol);
  return wellKnown === undefined ? symbol.getName() : `[Symbol.${wellKnown}]`;
}

const UNNAMEABLE: TransferTarget = {
  target: undefined,
  declaration: undefined,
};

/** A site that runs *something* the type cannot name, so it floors. */
function unnameable(node: ts.Node, site: TransferSite, text: string): Transfer {
  return { node, site, text, targets: [UNNAMEABLE] };
}

import ts from "typescript";
import { libDeclarationsOf, memberKey } from "./baseline/keys.js";
import { baselineEnumerates, floorSourceOf } from "./baseline/rung.js";
import type { AccessorFact, Color } from "./baseline/types.js";
import type { FloorReason, FloorSource } from "./colors.js";
import type {
  AccessExpression,
  DestructuringElement,
  Escape,
} from "./escapes.js";
import { signatureSegment } from "./segments.js";
import { settledType, type Resolution } from "./targets.js";

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

/**
 * What answers for one half of one member.
 *
 * `carried` is how a declared *property* that is really a getter gets a color
 * at all: there is no accessor declaration to read, so the carrier's fact is
 * the whole answer. `floor` is the other side of that coin — a lib member the
 * baseline states no fact about, where absence may not be read as data.
 */
export type TransferColor =
  | {
      readonly kind: "declaration";
      /** The body to read a color off, or absent when there is none. */
      readonly declaration: ts.SignatureDeclaration | undefined;
    }
  | {
      readonly kind: "carried";
      readonly color: Color;
      /** Absent where the declaration is not a standard-library one. */
      readonly source?: FloorSource | undefined;
    }
  | {
      readonly kind: "floor";
      readonly reason: FloorReason;
      /** Absent where the declaration is not a standard-library one. */
      readonly source?: FloorSource | undefined;
    };

export interface TransferTarget {
  /** Absent when the type cannot even name what runs. */
  readonly target: HiddenCallee | undefined;
  readonly color: TransferColor;
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
 * What the carrier chain has to say about a member's accessor-ness: the fact
 * itself, or which of the two things silence means here — the enumeration was
 * owed an answer and gave none, so the site floors, or nothing was owed and the
 * declaration answers.
 */
type AccessorAnswer = AccessorFact | "floors" | "declaration";

/**
 * The hidden transfers at one escape site, resolved through the static type.
 *
 * The chain that answers "is this member really an accessor?" is the carrier
 * chain first and the *declaration* second — not the declaration alone, which
 * #26/#29 proved false across ~2,500 first-party members. An accessor fact
 * outranks the declaration in both directions: it can say a declared property
 * is really a getter/setter pair, and it can say a member really is data.
 */
export function hiddenTransfersOf(
  escape: Escape,
  resolution: Resolution,
): readonly Transfer[] {
  const { checker } = resolution;
  switch (escape.kind) {
    case "throw":
      return [];
    case "call":
      // Only a call signature is keyed below; `new String(o)` and a tagged
      // template resolve to different members of the same lib interfaces.
      return ts.isCallExpression(escape.node)
        ? callTransfers(escape.node, resolution)
        : [];
    case "read":
    case "write":
    case "update":
      return accessTransfers(escape.node, escape.kind, resolution);
    case "destructure":
      return destructuringTransfers(escape.node, resolution);
    case "spread":
      return spreadTransfers(escape.node, escape.node.expression, resolution);
    case "coercion":
      return coercionTransfers(escape.node, checker);
    case "instance-check":
      return instanceCheckTransfers(escape.node, checker);
    case "consumption":
    case "iterator-throw":
      // The protocol members a consumption runs are resolved by the iteration
      // seam, which knows which call produced the iterator. There is nothing
      // left here for the static type alone to name.
      return [];
    case "await":
    case "float":
      // A rejection is the promise's own color, resolved by the call that
      // produced it. Nothing runs at the site itself.
      return [];
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
  resolution: Resolution,
): readonly Transfer[] {
  const { checker } = resolution;
  const text = textOf(node);
  const receiver = receiverType(node.expression, checker);
  if (receiver === undefined) {
    return [
      unnameable(node, site, text, opaqueReason(node.expression, checker)),
    ];
  }

  const half: Half =
    site === "read" ? "get" : site === "write" ? "set" : "both";
  const targets = ts.isPropertyAccessExpression(node)
    ? namedMemberTargets(receiver, node.name, half, resolution)
    : keyedMemberTargets(receiver, node.argumentExpression, half, resolution);

  return targets.length === 0 ? [] : [{ node, site, text, targets }];
}

/**
 * A member the receiver names, looked up on the receiver rather than read off
 * the checker's symbol for the access — which is the member of the arm a
 * narrowing picked, and so the same fault the settled receiver exists to
 * undo, one level along.
 *
 * A name the type does not carry resolves through an index signature, and an
 * index signature can only ever declare data: an accessor has to be written
 * out as a member to exist.
 */
function namedMemberTargets(
  receiver: ts.Type,
  name: ts.MemberName,
  half: Half,
  resolution: Resolution,
): readonly TransferTarget[] {
  const { checker } = resolution;
  // A `#private` name is not a member a type can be asked for — it is spelled
  // with an id only the checker knows — and only the class body declaring it
  // can hold the receiver, so no narrowing is at stake there either.
  if (ts.isPrivateIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name.parent);
    return symbol === undefined ? [] : accessorTargets(symbol, half, resolution);
  }
  return memberNamed(receiver, name.text, checker).flatMap((symbol) =>
    accessorTargets(symbol, half, resolution),
  );
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
  resolution: Resolution,
): readonly TransferTarget[] {
  const { checker } = resolution;
  const names = narrowKey(key, checker);
  const symbols =
    names === undefined
      ? membersOf(receiver, checker)
      : names.flatMap((name) => memberNamed(receiver, name, checker));
  return symbols.flatMap((symbol) => accessorTargets(symbol, half, resolution));
}

function narrowKey(
  key: ts.Expression,
  checker: ts.TypeChecker,
): readonly string[] | undefined {
  const type = settledType(key, checker);
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
  resolution: Resolution,
): readonly TransferTarget[] {
  const targets: TransferTarget[] = [];

  for (const declaration of symbol.declarations ?? []) {
    const answer = accessorAnswerFor(declaration, resolution);
    if (answer !== "declaration") {
      targets.push(
        ...statedTargets(symbol, half, answer, declaration, resolution.checker),
      );
      continue;
    }

    if (half !== "set" && ts.isGetAccessorDeclaration(declaration)) {
      targets.push({
        target: { kind: "getter", name: memberName(symbol) },
        color: { kind: "declaration", declaration },
      });
    }
    if (half !== "get" && ts.isSetAccessorDeclaration(declaration)) {
      targets.push({
        target: { kind: "setter", name: memberName(symbol) },
        color: { kind: "declaration", declaration },
      });
    }
  }

  return targets;
}

/**
 * What the chain makes of one declaration's accessor-ness.
 *
 * `false` is a *positive* record that the member really is data, which is why
 * absence is not that record and cannot be read as one. What absence leaves
 * behind depends on who declared the member: a hand-written `.d.ts` is the
 * trust base (#30 §C) and its declaration answers, but the first-party libs are
 * *not* — an enumeration of their real accessors exists, which is the whole
 * reason #29 §4 makes a missing fact floor there rather than read as data.
 */
function accessorAnswerFor(
  declaration: ts.Declaration,
  resolution: Resolution,
): AccessorAnswer {
  const answer = resolution.carrier.answerFor(declaration);
  const fact = answer?.kind === "entry" ? answer.entry.accessor : undefined;
  if (fact !== undefined) return fact;
  return isUnstatedLibProperty(declaration, resolution.checker)
    ? "floors"
    : "declaration";
}

/**
 * A member the baseline's enumeration was owed an answer about and gave none.
 * Only a *property* asks the accessor question at all — a method is a data
 * property on the prototype by construction, and reading one is a read whatever
 * else the member does — and only a type the enumeration reaches was owed one.
 */
function isUnstatedLibProperty(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): boolean {
  return (
    (ts.isPropertySignature(declaration) ||
      ts.isPropertyDeclaration(declaration)) &&
    baselineEnumerates(declaration, checker)
  );
}

/** The halves a site consults, colored by what the chain stated about them. */
function statedTargets(
  symbol: ts.Symbol,
  half: Half,
  fact: AccessorFact | "floors",
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): readonly TransferTarget[] {
  if (fact === false) return [];

  const targets: TransferTarget[] = [];
  const colorOf = (which: "get" | "set"): TransferColor =>
    fact === "floors"
      ? {
          kind: "floor",
          reason: "no-accessor-fact",
          source: floorSourceOf(declaration, "unstated", checker),
        }
      : {
          kind: "carried",
          color: fact[which],
          source: floorSourceOf(declaration, "stated", checker),
        };

  if (half !== "set") {
    targets.push({
      target: { kind: "getter", name: memberName(symbol) },
      color: colorOf("get"),
    });
  }
  if (half !== "get") {
    targets.push({
      target: { kind: "setter", name: memberName(symbol) },
      color: colorOf("set"),
    });
  }
  return targets;
}

function destructuringTransfers(
  node: DestructuringElement,
  resolution: Resolution,
): readonly Transfer[] {
  const text = textOf(node);
  const targets = ts.isBindingElement(node)
    ? bindingTargets(node, resolution)
    : assignmentTargets(node, resolution);

  if (targets === undefined) {
    return [
      unnameable(
        node,
        "destructure",
        text,
        opaqueReason(destructuredSource(node), resolution.checker),
      ),
    ];
  }
  return targets.length === 0
    ? []
    : [{ node, site: "destructure", text, targets }];
}

/** `undefined` where the source type cannot be read: the caller floors. */
function bindingTargets(
  element: ts.BindingElement,
  resolution: Resolution,
): readonly TransferTarget[] | undefined {
  const { checker } = resolution;
  const source = receiverType(element.parent, checker);
  if (source === undefined) return undefined;
  if (element.dotDotDotToken !== undefined) {
    return ownEnumerableTargets(source, resolution);
  }

  const name = element.propertyName ?? element.name;
  if (ts.isComputedPropertyName(name)) {
    return keyedMemberTargets(source, name.expression, "get", resolution);
  }
  if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
    // Only reachable with a property name, which the branch above took.
    return [];
  }

  return memberNamed(source, name.text, checker).flatMap((symbol) =>
    accessorTargets(symbol, "get", resolution),
  );
}

/**
 * A destructuring assignment reads its source exactly as a binding pattern
 * does, but the pattern is spelled as an object literal whose own type says
 * nothing about where the values come from. What the assignment names is read
 * where the syntax names it; a pattern nested inside another has the checker
 * answer for it, as it did before there was a settled type to prefer. The rest
 * floors.
 */
function assignmentTargets(
  element: Exclude<DestructuringElement, ts.BindingElement>,
  resolution: Resolution,
): readonly TransferTarget[] | undefined {
  const { checker } = resolution;
  const assigned = assignedSourceNode(element.parent);
  const source =
    assigned === undefined ? undefined : receiverType(assigned, checker);

  if (ts.isSpreadAssignment(element)) {
    return source === undefined
      ? undefined
      : ownEnumerableTargets(source, resolution);
  }

  const { name } = element;
  if (!ts.isIdentifier(name)) return undefined;
  if (source !== undefined) {
    return memberNamed(source, name.text, checker).flatMap((symbol) =>
      accessorTargets(symbol, "get", resolution),
    );
  }
  const symbol = checker.getPropertySymbolOfDestructuringAssignment(name);
  return symbol === undefined ? [] : accessorTargets(symbol, "get", resolution);
}

/** The value a destructuring pattern is assigned, where the syntax says. */
function assignedSourceNode(
  pattern: ts.ObjectLiteralExpression,
): ts.Expression | undefined {
  const { parent } = pattern;
  return ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === pattern
    ? parent.right
    : undefined;
}

/**
 * The syntax a destructuring site takes apart, where the syntax names it. A
 * pattern is only the shape, so which floor a site here is comes down to the
 * type of *this* — and a pattern assigned by something the syntax does not name
 * has no type that could have been widened.
 */
function destructuredSource(
  element: DestructuringElement,
): ts.Node | undefined {
  return ts.isBindingElement(element)
    ? element.parent
    : assignedSourceNode(element.parent);
}

function spreadTransfers(
  node: ts.Node,
  source: ts.Expression,
  resolution: Resolution,
): readonly Transfer[] {
  const text = textOf(source);
  const { checker } = resolution;
  const type = receiverType(source, checker);
  if (type === undefined) {
    return [unnameable(node, "spread", text, opaqueReason(source, checker))];
  }

  const targets = ownEnumerableTargets(type, resolution);
  return targets.length === 0 ? [] : [{ node, site: "spread", text, targets }];
}

function ownEnumerableTargets(
  source: ts.Type,
  resolution: Resolution,
): readonly TransferTarget[] {
  return membersOf(source, resolution.checker).flatMap((symbol) =>
    (symbol.declarations ?? []).flatMap((declaration) => {
      if (!mayBeOwn(declaration, resolution.checker)) return [];

      const answer = accessorAnswerFor(declaration, resolution);
      if (answer !== "declaration") {
        return statedTargets(
          symbol,
          "get",
          answer,
          declaration,
          resolution.checker,
        );
      }
      return ts.isGetAccessorDeclaration(declaration)
        ? [
            {
              target: { kind: "getter" as const, name: memberName(symbol) },
              color: { kind: "declaration" as const, declaration },
            },
          ]
        : [];
    }),
  );
}

/**
 * A member written in a class body and not `static` lives on the prototype, so
 * an instance does not own it. A member of a `lib.*.d.ts` interface is the same
 * thing said differently: the libs describe built-in objects, whose accessors
 * both ECMA-262 and WebIDL put on the prototype — which is exactly why the
 * baseline's own derivation reads them off one — so spreading a DOM element
 * touches nothing (#29 §1). Anywhere else own-ness has no answer: a member
 * declared on an interface or a type literal could describe either an object
 * literal or a class instance, and the sound reading of that is that it is own.
 */
function mayBeOwn(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): boolean {
  if (libDeclarationsOf(declaration, checker).length > 0) return false;
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
  const type = settledType(value, checker);
  if ((type.flags & OPAQUE_TYPE) !== 0) {
    return [unnameable(value, "coercion", text, opaqueReason(value, checker))];
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
  const constructor = settledType(node.right, checker);
  if ((constructor.flags & OPAQUE_TYPE) !== 0) {
    return [
      unnameable(
        node,
        "instance-check",
        text,
        opaqueReason(node.right, checker),
      ),
    ];
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
  resolution: Resolution,
): readonly Transfer[] {
  const { checker } = resolution;
  const callee = libCalleeKey(call, checker);
  if (callee === "ObjectConstructor#assign") {
    return call.arguments.slice(1).flatMap((source) =>
      // A spread argument's sources are the elements of whatever it spreads,
      // and the syntax names none of them.
      ts.isSpreadElement(source)
        ? [unnameable(source, "spread", textOf(source), "unresolvable")]
        : spreadTransfers(source, source, resolution),
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
  const resolved = checker.getResolvedSignature(call)?.declaration;
  if (resolved === undefined) return undefined;

  for (const { declaration } of libDeclarationsOf(resolved, checker)) {
    const owner = declaration.parent;
    if (!ts.isInterfaceDeclaration(owner)) continue;
    const name =
      signatureSegment(ts, declaration) ??
      ts.getNameOfDeclaration(declaration)?.getText();
    if (name !== undefined) return memberKey(owner.name.text, name);
  }
  return undefined;
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
  if (declarations.length === 0) {
    return [{ target, color: { kind: "declaration", declaration: undefined } }];
  }

  return declarations.map((declaration) => ({
    target,
    color: {
      kind: "declaration" as const,
      // A conversion member declared as data — `toString: () => string` — names
      // no body to read a color off.
      declaration: ts.isFunctionLike(declaration) ? declaration : undefined,
    },
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

/**
 * The apparent type of a receiver, or nothing when it cannot be read. It is
 * the *settled* type: a hidden transfer is not a question the reader wrote, so
 * the arm a guard picked is no answer to which body it enters.
 */
function receiverType(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  return readable(settledType(node, checker), checker);
}

/** A type as a member lookup sees it, or nothing where it says nothing. */
function readable(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const apparent = checker.getApparentType(type);
  return (apparent.flags & OPAQUE_TYPE) === 0 ? apparent : undefined;
}

/**
 * Which floor an unreadable type is, which are two different problems with two
 * different fixes. Settling reads past a narrowing, so a type the checker could
 * have read here and this could not is one the widening made unreadable: the
 * binding is a `let` whose assignments the engine does not track, not a value
 * nothing could ever have named. Only the first has `const` as its answer, and
 * none of a floor's package-boundary outs can reach either.
 */
function opaqueReason(
  node: ts.Node | undefined,
  checker: ts.TypeChecker,
): FloorReason {
  if (node === undefined) return "unresolvable";
  return readable(checker.getTypeAtLocation(node), checker) === undefined
    ? "unresolvable"
    : "mutable-binding";
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

const UNNAMEABLE: TransferTarget = unnameableTarget("unresolvable");

function unnameableTarget(reason: FloorReason): TransferTarget {
  return { target: undefined, color: { kind: "floor", reason } };
}

/** A site that runs *something* the type cannot name, so it floors. */
function unnameable(
  node: ts.Node,
  site: TransferSite,
  text: string,
  reason: FloorReason,
): Transfer {
  return { node, site, text, targets: [unnameableTarget(reason)] };
}

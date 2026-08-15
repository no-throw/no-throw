import ts from "typescript";
import { floorSourceOf } from "./baseline/rung.js";
import type { Color } from "./baseline/types.js";
import type { Carrier } from "./carrier/chain.js";
import { carriedFacts } from "./carrier/entries.js";
import type { FloorReason, FloorSource } from "./colors.js";
import {
  conditionKey,
  parameterRoot,
  pathKey,
  pathOf,
  skipParens,
  type Condition,
  type ParameterPath,
} from "./conditions.js";
import {
  bodyOf,
  constructedBody,
  hasVisibleBody,
  inheritedFrom,
  isAmbient,
  type Bodied,
} from "./declarations.js";
import { calleeExpression, type Transfer } from "./escapes.js";
import { isMarkedFunction } from "./marks.js";

/**
 * What resolving a callee takes. The checker answers what the program says;
 * the carrier answers everything the program has no body for, and the two
 * travel together because a target is only ever one or the other.
 */
export interface Resolution {
  readonly checker: ts.TypeChecker;
  readonly carrier: Carrier;
}

/**
 * What an expression in callee or argument position turns out to name. The two
 * positions ask the same question — whose body would run — so they get the
 * same answer type and the same resolver.
 */
export type Target =
  /** A path over the asking function's own parameters: a condition, not a floor. */
  | { readonly kind: "condition"; readonly path: ParameterPath }
  | {
      readonly kind: "function";
      readonly declaration: Bodied;
      /** Marked, so its color is pinned and its body is enforced elsewhere. */
      readonly marked: boolean;
    }
  /**
   * Colored by the carrier chain rather than by a body: a shipped manifest, a
   * surviving tag on a bodyless declaration, and — as the chain grows — an
   * overlay, an override or the baseline. A pin like a mark, with no body for
   * the fixpoint to walk.
   */
  | {
      readonly kind: "carried";
      readonly color: Color;
      /**
       * Whether the declaration was `async`. Declaration emit erases it, so a
       * carrier is the only thing that can say a callee rejects rather than
       * sync-throws.
       */
      readonly async: boolean;
      /** Empty on a throwing entry: nothing to discharge. */
      readonly conditions: readonly Condition[];
      /** Absent where the declaration is not a standard-library one. */
      readonly source?: FloorSource | undefined;
    }
  | {
      readonly kind: "floor";
      readonly reason: FloorReason;
      /** The file whose hash drifted; only `stale-manifest` carries one. */
      readonly staleFile?: string | undefined;
      /** Absent where the declaration is not a standard-library one. */
      readonly source?: FloorSource | undefined;
    };

/**
 * What a *declaration* names, as opposed to a value in hand. A condition is a
 * fact about the expression an argument was written as, so nothing reached
 * through a declaration alone can be one.
 */
export type DeclaredTarget = Exclude<Target, { readonly kind: "condition" }>;

/**
 * What an expression resolved to, or why it did not. `mutable` is kept apart
 * from `unknown` because a `let` is a refinement the engine has not made yet,
 * while an unfollowable expression is unknowable from here.
 */
export type ValueResolution =
  | { readonly kind: "targets"; readonly targets: readonly Target[] }
  | { readonly kind: "mutable" }
  | { readonly kind: "unknown" };

/** The same answer for an expression a path is walked through, not entered. */
export type ReceiverResolution =
  | { readonly kind: "values"; readonly values: readonly ts.Expression[] }
  | { readonly kind: "mutable" }
  | { readonly kind: "unknown" };

/**
 * The callee of one transfer, as seen from the body it is written in. A join,
 * not a single answer: losing the callee to a branch means every function the
 * branch can reach, which over-approximates the condition set rather than
 * guessing which arm runs.
 */
export function calleeTargets(
  transfer: Transfer,
  body: Bodied,
  resolution: Resolution,
): readonly Target[] {
  const resolved = resolveValue(calleeExpression(transfer), body, resolution);
  // The signature is the function *type*, which is what a reassignable binding
  // resolves to and is one of the values it can hold, not the one that runs.
  if (resolved.kind === "mutable") return [floor("mutable-binding")];
  if (resolved.kind !== "targets") return [transferTarget(transfer, resolution)];

  const stated = resolved.targets.some((target) => target.kind === "condition")
    ? statedTarget(transfer, resolution)
    : undefined;
  return stated === undefined ? resolved.targets : [...resolved.targets, stated];
}

/**
 * What a carrier says about the member a path names, where one says anything.
 *
 * `users.map(cb)` is two facts at once: the body enters a member of its own
 * parameter, which is a condition its caller discharges, *and* the static type
 * names `Array#map`, which the baseline colors and conditions on the callback
 * written right here. Taking only the first loses the second, and the second is
 * the whole of stories 32–33 — the same call judged on the callback actually
 * passed. Both are reported, so this can only ever tighten: the condition still
 * covers whatever function really turns up at the path.
 *
 * Nothing is stated for a member no carrier answers for — `repo.save` on an
 * interface you wrote is exactly the shape #23's paths exist for, and floors
 * here would make every one of them unusable.
 */
function statedTarget(
  transfer: Transfer,
  resolution: Resolution,
): Target | undefined {
  const declaration = targetOf(transfer, resolution.checker);
  if (declaration === undefined || hasVisibleBody(declaration)) return undefined;
  const keyedBy = keyDeclarationFor(declaration, transfer, resolution);
  return resolution.carrier.answerFor(keyedBy) === undefined
    ? undefined
    : carriedTarget(declaration, resolution, keyedBy);
}

/**
 * Follow an expression to the functions it can name. Only single-assignment
 * shapes are followed — a function literal, a `const` bound to one, a branch
 * between them — because those are the ones where the answer cannot change
 * between here and the call.
 */
export function resolveValue(
  expr: ts.Expression,
  body: Bodied,
  resolution: Resolution,
  seen: Set<ts.Node> = new Set(),
): ValueResolution {
  const { checker } = resolution;
  const expression = skipParens(expr);

  const root = parameterRoot(expression, body, checker);
  if (root === "own") {
    const path = pathOf(expression, body, checker);
    return path === undefined
      ? { kind: "unknown" }
      : { kind: "targets", targets: [{ kind: "condition", path }] };
  }
  if (root === "captured") {
    return { kind: "targets", targets: [floor("captured")] };
  }

  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
    return { kind: "targets", targets: [functionTarget(expression)] };
  }

  if (ts.isConditionalExpression(expression)) {
    const whenTrue = resolveValue(expression.whenTrue, body, resolution, seen);
    if (whenTrue.kind !== "targets") return whenTrue;
    const whenFalse = resolveValue(expression.whenFalse, body, resolution, seen);
    if (whenFalse.kind !== "targets") return whenFalse;
    return {
      kind: "targets",
      targets: [...whenTrue.targets, ...whenFalse.targets],
    };
  }

  if (ts.isIdentifier(expression)) {
    return resolveBinding(expression, body, resolution, seen);
  }

  return { kind: "unknown" };
}

function resolveBinding(
  identifier: ts.Identifier,
  body: Bodied,
  resolution: Resolution,
  seen: Set<ts.Node>,
): ValueResolution {
  const { checker } = resolution;
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (declaration === undefined) return { kind: "unknown" };

  if (ts.isFunctionDeclaration(declaration)) {
    return {
      kind: "targets",
      targets: [declarationTarget(declaration, resolution)],
    };
  }

  if (!ts.isVariableDeclaration(declaration)) return { kind: "unknown" };
  // An ambient `declare var` — `Error` among them — is a bodyless declaration
  // wearing a mutable binding's syntax, not a value the engine could one day
  // track through its assignments. The declaration is what answers for it.
  if (isAmbient(declaration)) return { kind: "unknown" };
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) {
    return { kind: "mutable" };
  }

  const { initializer } = declaration;
  if (initializer === undefined || seen.has(declaration)) {
    return { kind: "unknown" };
  }
  seen.add(declaration);
  return resolveValue(initializer, body, resolution, seen);
}

/**
 * Follow an expression to the values it can hold, for a path that has to be
 * walked *through* it rather than entered. A binding's declared type is only a
 * supertype's promise — a subclass can override the very member the path names
 * — so the walk starts at the value in hand, whose own type is exact. An object
 * literal, an array literal and a `new` are each a value in hand.
 *
 * A primitive type is where that promise is already a certainty, whatever the
 * expression carrying it: no subtype of `string` exists to override
 * `startsWith`, so every value the type admits looks the member up on the one
 * prototype the libs declare. Without this, `f(s: string)` calling
 * `s.startsWith` conditions on a path no call site could ever answer, and the
 * obligation is deferred forever rather than ever discharged.
 */
export function resolveReceiver(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node> = new Set(),
): ReceiverResolution {
  const expression = skipParens(expr);

  if (hasExactType(expression, checker)) {
    return { kind: "values", values: [expression] };
  }

  if (
    ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isNewExpression(expression)
  ) {
    return { kind: "values", values: [expression] };
  }

  if (ts.isConditionalExpression(expression)) {
    const whenTrue = resolveReceiver(expression.whenTrue, checker, seen);
    if (whenTrue.kind !== "values") return whenTrue;
    const whenFalse = resolveReceiver(expression.whenFalse, checker, seen);
    if (whenFalse.kind !== "values") return whenFalse;
    return { kind: "values", values: [...whenTrue.values, ...whenFalse.values] };
  }

  if (!ts.isIdentifier(expression)) return { kind: "unknown" };

  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) {
    return { kind: "unknown" };
  }
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) {
    return { kind: "mutable" };
  }

  const { initializer } = declaration;
  if (initializer === undefined || seen.has(declaration)) {
    return { kind: "unknown" };
  }
  seen.add(declaration);
  return resolveReceiver(initializer, checker, seen);
}

/**
 * The types with exactly one prototype behind them, so that naming the type
 * names the declaration a member lookup lands on.
 *
 * `null`, `undefined` and `void` are deliberately not in the set. They are
 * primitive too, but they carry no member to look up at all, and reading them
 * as exact would turn "this receiver has no members" into an answer about one.
 */
const EXACT_TYPE =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike;

/**
 * Whether the expression's type settles the member lookup by itself. A type
 * parameter is not a primitive, but a constraint that is bounds every value it
 * can hold — so `k.startsWith` on `K extends string` resolves like `string`'s.
 */
function hasExactType(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = assignableType(expr, checker);
  if (isExactType(type)) return true;
  const constraint = checker.getBaseConstraintOfType(type);
  return constraint !== undefined && isExactType(constraint);
}

/**
 * The type every value the expression can arrive as satisfies — which is not
 * the checker's type *at* it wherever something can assign to it.
 *
 * A narrowing is a fact about one path, and an assignment the checker did not
 * follow outruns it: TypeScript keeps `let v: string | Bag` narrowed to
 * `string` across a call that writes `v` from a closure, and the member run
 * there is `Bag`'s. What the binding was *declared* as is the one thing every
 * value it can hold really keeps, so exactness is read off that — which leaves
 * `let text = input` on a `string` exact, as it should be, and puts
 * `let v: string | Bag` back on the floor it had before access paths reached
 * primitives at all.
 *
 * A `const` needs none of this. Nothing can write one, so a narrowing of it is
 * the whole truth about it, and reading past that would give up precision for
 * nothing.
 */
function assignableType(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): ts.Type {
  const declaration = ts.isIdentifier(expr)
    ? checker.getSymbolAtLocation(expr)?.valueDeclaration
    : undefined;
  return declaration !== undefined && isWritable(declaration)
    ? checker.getTypeAtLocation(declaration)
    : checker.getTypeAtLocation(expr);
}

function isWritable(declaration: ts.Declaration): boolean {
  if (ts.isParameter(declaration)) return true;
  return (
    ts.isVariableDeclaration(declaration) &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
  );
}

/** A union is exact only where every arm is: the member lookup is joined. */
function isExactType(type: ts.Type): boolean {
  const parts = type.isUnion() ? type.types : [type];
  return parts.every((part) => (part.flags & EXACT_TYPE) !== 0);
}

/**
 * The target a member of a value names, joined over its declarations. Which
 * function a member holds is answered by the checker's symbol for it, which is
 * the whole reason a condition can reach past depth 0 at all.
 *
 * The walk starts where exactness was decided, or a declared `string | number`
 * narrowed to `string` would resolve `String#toString` and never meet the
 * `Number#toString` the value may really carry.
 */
export function memberTargets(
  value: ts.Expression,
  members: readonly string[],
  resolution: Resolution,
): readonly Target[] {
  const { checker } = resolution;
  let type = assignableType(value, checker);
  let symbol: ts.Symbol | undefined;

  for (const member of members) {
    symbol = type.getProperty(member);
    if (symbol === undefined) return [floor("unresolvable")];
    type = checker.getTypeOfSymbolAtLocation(symbol, value);
  }

  const declarations = symbol?.declarations ?? [];
  if (declarations.length === 0) return [floor("unresolvable")];
  return distinct(
    declarations.map((declaration) => memberTarget(declaration, resolution)),
  );
}

/**
 * The join, less the answers it says twice. One member is routinely declared
 * several times over — an overload pair, an interface the libs merge across two
 * `lib.*.d.ts` files — and each of those declarations names the same runtime
 * function, so the chain answers for all of them alike and reporting each would
 * report one call twice. Only a union's members are genuinely several functions,
 * and those answer for themselves.
 */
function distinct(targets: readonly Target[]): readonly Target[] {
  const byKey = new Map<string | Bodied, Target>();
  for (const target of targets) {
    const key = targetKey(target);
    if (!byKey.has(key)) byKey.set(key, target);
  }
  return [...byKey.values()];
}

/**
 * What makes two targets the same answer. A body is identified by its node,
 * since two bodies are two functions however alike they read; everything else is
 * identified by what it states, since a stated color has no other content.
 *
 * The return type is written out so that a target kind added later fails to
 * compile here rather than keying as nothing and quietly collapsing onto some
 * other answer.
 */
function targetKey(target: Target): string | Bodied {
  switch (target.kind) {
    case "function":
      return target.declaration;
    case "condition":
      return JSON.stringify(["condition", pathKey(target.path)]);
    case "carried":
      return JSON.stringify([
        "carried",
        target.color,
        target.async,
        target.source,
        target.conditions.map(conditionKey),
      ]);
    case "floor":
      return JSON.stringify([
        "floor",
        target.reason,
        target.staleFile,
        target.source,
      ]);
  }
}

function memberTarget(
  declaration: ts.Declaration,
  resolution: Resolution,
): Target {
  if (
    ts.isMethodDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration)
  ) {
    return declarationTarget(declaration, resolution);
  }

  const initializer = initializerOf(declaration);
  if (
    initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  ) {
    return functionTarget(initializer);
  }

  if (ts.isMethodSignature(declaration)) {
    return carriedTarget(declaration, resolution);
  }
  // A property holding a function type names no parameter list a condition
  // could be a path over, so nothing keyed on it could be discharged here.
  return floor(
    ts.isPropertySignature(declaration) ? "bodyless" : "unresolvable",
    floorSourceOf(declaration, "unstated", resolution.checker),
  );
}

function initializerOf(declaration: ts.Declaration): ts.Expression | undefined {
  if (
    ts.isPropertyAssignment(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isVariableDeclaration(declaration)
  ) {
    return declaration.initializer;
  }
  return undefined;
}

/**
 * The chain up to, but not including, inference: a mark is trusted here and
 * verified separately against its own body — assume-then-verify, so a cycle
 * through a seed is colored against the mark and a lying mark fails loud where
 * it was written rather than quietly poisoning its callers.
 */
function transferTarget(transfer: Transfer, resolution: Resolution): Target {
  const target = targetOf(transfer, resolution.checker);
  if (target === undefined) return floor("unresolvable");
  return hasVisibleBody(target)
    ? functionTarget(target)
    : carriedTarget(
        target,
        resolution,
        keyDeclarationFor(target, transfer, resolution),
      );
}

/**
 * Which declaration a carrier is asked about, where that is not the one whose
 * parameter list runs.
 *
 * A binding typed with a *named* function type — `red: Formatter`, the shape
 * much of npm's declarations take — resolves to the function type written in
 * the alias, and that node is shared by every binding the alias types. It
 * cannot carry a key: keying it would color `green` with whatever was said
 * about `red`. What a consumer names is the binding, so the binding is what the
 * chain is asked about, and the signature still supplies the facts.
 *
 * Only asked where the signature itself keys nothing, so a declaration the
 * surface already reaches is never re-keyed through the site that reached it.
 * Keys nothing, rather than *answers* nothing: `interface Risky { (…): … }` is
 * reachable as `Risky#()` whether or not anybody wrote that entry, and falling
 * through to the property over an unwritten key would color a call from an
 * entry written for a member no call enters. A bare `type Paint = (…) => …` is
 * the shape that really carries no key, and it is the one this is for.
 *
 * And only of a callee written as a name: `new` resolves to a class rather than
 * to a signature, and `super` names nothing at all.
 */
function keyDeclarationFor(
  declaration: ts.Declaration,
  transfer: Transfer,
  resolution: Resolution,
): ts.Declaration {
  const { carrier } = resolution;
  if (
    ts.isNewExpression(transfer) ||
    carrier.answerFor(declaration) !== undefined ||
    carrier.keyFor(declaration) !== undefined
  ) {
    return declaration;
  }

  const callee = calleeExpression(transfer);
  if (
    !ts.isIdentifier(callee) &&
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return declaration;
  }

  // Through the import, because what the consumer named is the package's
  // declaration and the specifier is only how it got here.
  const { checker } = resolution;
  const named = checker.getSymbolAtLocation(callee);
  if (named === undefined) return declaration;
  const resolved =
    (named.flags & ts.SymbolFlags.Alias) === 0
      ? named
      : checker.getAliasedSymbol(named);

  return resolved.declarations?.[0] ?? declaration;
}

/**
 * What the carrier chain makes of a declaration with no body to read. Module
 * resolution has already decided this is the chain's question rather than the
 * program's: source resolves to a visible body and never arrives here.
 *
 * The key and the facts can come from two declarations: what a consumer names
 * is not always what holds the parameter list a condition is a path over.
 */
function carriedTarget(
  declaration: ts.SignatureDeclaration | ts.ClassLikeDeclaration,
  resolution: Resolution,
  keyedBy: ts.Declaration = declaration,
): DeclaredTarget {
  // Every floor below is the chain declining to state a color, whatever its
  // reason for declining, so all of them read `stated` the same way.
  const unstated = floorSourceOf(declaration, "unstated", resolution.checker);

  const answer = resolution.carrier.answerFor(keyedBy);
  if (answer === undefined) return floor("bodyless", unstated);
  if (answer.kind === "floor") {
    return {
      kind: "floor",
      reason: answer.reason,
      staleFile: answer.staleFile,
      source: unstated,
    };
  }
  // An entry that carries only an accessor fact says nothing about calling it,
  // and an unanswered question is the ordinary floor.
  if (answer.entry.color === undefined) return floor("bodyless", unstated);

  const facts = carriedFacts(declaration, answer.entry, resolution.checker);
  if (facts === undefined) return floor("unusable-entry", unstated);
  return {
    kind: "carried",
    color: facts.color,
    async: facts.async,
    conditions: facts.color === "throwing" ? [] : facts.conditions,
    source: floorSourceOf(declaration, "stated", resolution.checker),
  };
}

/**
 * The bodies `new` on a constructor-position expression enters, as targets. The
 * implicit `constructor(...args) { super(...args) }` a class does not declare
 * has no syntax for the walk to find, so its edge is asked for by name.
 *
 * A join rather than one answer, because with no argument list written there is
 * no overload resolution either: a base known only by its construct signatures
 * — `declare var Error: ErrorConstructor` is the one every project meets — has
 * every one of them within reach of the arguments the implicit constructor
 * forwards, so every one of them answers.
 */
export function constructedTargets(
  expression: ts.Expression,
  resolution: Resolution,
): readonly DeclaredTarget[] {
  const { checker } = resolution;
  const body = constructedBodyAt(expression, checker);
  if (body !== undefined) return [declarationTarget(body, resolution)];

  const signatures = bodylessConstructSignatures(expression, checker);
  return signatures.length === 0
    ? [floor("unresolvable")]
    : signatures.map((declaration) =>
        declarationTarget(declaration, resolution),
      );
}

/**
 * The target a declaration names, or the floor for a site nothing named. A
 * hidden transfer resolves through the static type rather than through an
 * expression, so this is the whole answer for one.
 */
export function declaredTarget(
  declaration: Bodied | undefined,
  resolution: Resolution,
): DeclaredTarget {
  return declaration === undefined
    ? floor("unresolvable")
    : declarationTarget(declaration, resolution);
}

/** The body an escape site transfers control into, where one can be named. */
function targetOf(
  transfer: Transfer,
  checker: ts.TypeChecker,
): Bodied | undefined {
  if (ts.isNewExpression(transfer)) {
    return (
      constructedBodyAt(transfer.expression, checker) ??
      constructSignatureOf(transfer, checker)
    );
  }
  if (calleeExpression(transfer).kind === ts.SyntaxKind.SuperKeyword) {
    const base = inheritedFrom(transfer);
    return (
      (base === undefined ? undefined : constructedBodyAt(base, checker)) ??
      constructSignatureOf(transfer, checker)
    );
  }

  const declaration = checker.getResolvedSignature(transfer)?.declaration;
  return declaration !== undefined && ts.isFunctionLike(declaration)
    ? declaration
    : undefined;
}

/**
 * The class a constructor-position expression denotes, and the body `new` on it
 * enters. The resolved *signature* is no substitute: a derived class that
 * declares no constructor resolves to its base's, which would skip the derived
 * class's own field initializers.
 */
function constructedBodyAt(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): Bodied | undefined {
  const declaration =
    checker.getTypeAtLocation(expression).symbol?.valueDeclaration;
  return declaration !== undefined && ts.isClassLike(declaration)
    ? constructedBody(declaration)
    : undefined;
}

/**
 * A construct signature with no class behind it — `new Error()`, an interface's
 * `new ()` — is a bodyless declaration, and saying that beats saying nothing
 * resolved. Only a bodyless one is taken: a bodied signature the class lookup
 * missed means the expression was not one class, and reading a single branch of
 * it would be a guess.
 *
 * `super(...)` is the same construction under another spelling, and reaches the
 * same base the same way. Nothing about the base being named by `extends` makes
 * it any more resolvable than a `new` on it, so the two ask this one question.
 */
function constructSignatureOf(
  construction: Transfer,
  checker: ts.TypeChecker,
): ts.SignatureDeclaration | undefined {
  return bodylessSignature(
    checker.getResolvedSignature(construction)?.declaration,
  );
}

/**
 * Every construct signature of a type that has no body behind it. What answers
 * where no argument list picked one — the implicit `super()`.
 */
function bodylessConstructSignatures(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): readonly ts.SignatureDeclaration[] {
  return checker
    .getTypeAtLocation(expression)
    .getConstructSignatures()
    .flatMap(({ declaration }) => {
      const bodyless = bodylessSignature(declaration);
      return bodyless === undefined ? [] : [bodyless];
    });
}

/** The declaration, where it is a signature with no body, and nothing else. */
function bodylessSignature(
  declaration: ts.Declaration | undefined,
): ts.SignatureDeclaration | undefined {
  return declaration !== undefined &&
    ts.isFunctionLike(declaration) &&
    bodyOf(declaration) === undefined
    ? declaration
    : undefined;
}

/**
 * A declaration named by something other than a transfer — a protocol member
 * reached through the static type — as a target.
 */
export function declarationTarget(
  declaration: Bodied,
  resolution: Resolution,
): DeclaredTarget {
  return hasVisibleBody(declaration)
    ? functionTarget(declaration)
    : carriedTarget(declaration, resolution);
}

function functionTarget(declaration: Bodied): DeclaredTarget {
  return {
    kind: "function",
    declaration,
    marked: isMarkedFunction(declaration),
  };
}

function floor(
  reason: FloorReason,
  source?: FloorSource | undefined,
): DeclaredTarget {
  return { kind: "floor", reason, source };
}

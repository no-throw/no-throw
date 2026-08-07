import ts from "typescript";
import type {
  ConsumptionReason,
  ThrowingReason,
  UndischargedReason,
} from "./colors.js";
import { pathKey, type Condition } from "./conditions.js";
import { dischargeAt, type Outcome } from "./discharge.js";
import {
  baseClassExpression,
  isGenerator,
  returnedExpressions,
  type Bodied,
} from "./declarations.js";
import {
  unbridgedEscapes,
  type Escape,
  type Phase,
  type Transfer,
} from "./escapes.js";
import { createFixpoint } from "./infer.js";
import {
  constituentsOf,
  isIteratorType,
  protocolMember,
  type Consumption,
  type Protocol,
  type ProtocolMemberName,
} from "./iteration.js";
import { originatingCall } from "./originating-call.js";
import { colorPolicy } from "./policy.js";
import {
  calleeTargets,
  constructedTarget,
  declarationTarget,
  type Target,
} from "./targets.js";

/**
 * One reason a body escapes. A transfer can produce several — a lost callee
 * conditions every parameter its branch reaches, and each is answered for
 * separately — so the walk hands back reasons rather than a verdict per site.
 */
export type BodyEscape =
  | { readonly kind: "throw"; readonly node: ts.ThrowStatement }
  | {
      readonly kind: "callee";
      readonly node: Transfer;
      readonly reason: ThrowingReason;
    }
  /** A condition whose argument was read and can throw — a true positive. */
  | {
      readonly kind: "argument-throwing";
      readonly node: Transfer;
      readonly condition: Condition;
    }
  | {
      readonly kind: "argument-floored";
      readonly node: Transfer;
      readonly condition: Condition;
      readonly reason: UndischargedReason;
    }
  /** A `for…of`, spread, destructuring, `.next()` or `yield*`. */
  | {
      readonly kind: "consumption";
      readonly node: ts.Node;
      readonly reason: ConsumptionReason;
    }
  /** `.throw()`: the consumer throwing, with a detour through the iterator. */
  | { readonly kind: "iterator-throw"; readonly node: ts.Node }
  /** An iterator handed out, which the mark covers consuming. */
  | {
      readonly kind: "returned-iterator";
      readonly node: ts.Expression;
      readonly reason: ConsumptionReason;
    };

/**
 * The color-resolution seam. Every "what color is this callee?" question goes
 * through here, so inference and the resolver chain — overrides, overlays,
 * shipped manifests, the baseline — land behind this one object instead of
 * being threaded through the walk.
 *
 * Inference is the last rung and a removable one: with the `declare` policy the
 * chain stops at the pins and everything unmarked floors, which is the sound
 * end of the range rather than a degraded mode. Conditions are not on that
 * rung — they are the lattice itself, read off the body under either policy.
 */
export interface ColorResolver {
  /** Every reason `body` escapes, in source order. */
  escapesIn(body: Bodied): readonly BodyEscape[];
}

/**
 * A generator's call and its iterator are two colors over one body — the call
 * runs the parameter list, consumption runs everything else — so what the
 * throwing dimension colors is a facet of a declaration rather than the
 * declaration itself. For every other function kind the call facet is the whole
 * body, and the iteration facet is whatever its `return` hands back.
 *
 * Conditions need no facets: which parameters a body enters is one fact about
 * it whenever the entering happens, and the call is where the argument that
 * will be entered is fixed either way.
 */
type Facet = "call" | "iteration";

interface ColorNode {
  readonly declaration: Bodied;
  readonly facet: Facet;
}

/** A callee with source behind it: the only target a condition can be asked about. */
type BodiedTarget = Extract<Target, { kind: "function" }>;

/** One callee of one transfer, with the transfer it was written at. */
interface SiteTarget {
  readonly site: Transfer;
  readonly target: Target;
}

/** One condition of one callee, resolved at the site it lands on. */
interface Discharged {
  readonly condition: Condition;
  readonly outcome: Outcome;
}

/** What a body's conditions are read against while its group is unresolved. */
type Conditions = (body: Bodied) => readonly Condition[];

/** What running one part of the iteration protocol turns out to enter. */
type Consumed =
  | { readonly kind: "clean" }
  | { readonly kind: "color"; readonly node: ColorNode }
  | { readonly kind: "floor"; readonly reason: ConsumptionReason };

const CONSUMED_CLEAN: Consumed = { kind: "clean" };

export function createColorResolver(checker: ts.TypeChecker): ColorResolver {
  const policy = colorPolicy();

  const walks = new Map<Bodied, Map<Phase, readonly Escape[]>>();
  const targetsAt = new Map<Transfer, readonly Target[]>();
  const outcomesAt = new Map<Transfer, Map<string, readonly Outcome[]>>();
  const consumedAt = new Map<ts.Node, readonly Consumed[]>();
  const interned = new Map<Bodied, Map<Facet, ColorNode>>();

  /**
   * Node identity is the memo key, so a facet of a declaration has to be one
   * object however many sites ask about it.
   */
  function nodeFor(declaration: Bodied, facet: Facet): ColorNode {
    const facets = interned.get(declaration) ?? new Map<Facet, ColorNode>();
    interned.set(declaration, facets);
    const known = facets.get(facet);
    if (known !== undefined) return known;
    const node: ColorNode = { declaration, facet };
    facets.set(facet, node);
    return node;
  }

  function escapesOf(body: Bodied, phase: Phase): readonly Escape[] {
    const byPhase = walks.get(body) ?? new Map<Phase, readonly Escape[]>();
    walks.set(body, byPhase);
    const known = byPhase.get(phase);
    if (known !== undefined) return known;
    const found = unbridgedEscapes(body, checker, phase);
    byPhase.set(phase, found);
    return found;
  }

  /** Which half of a call's work one node stands for. */
  function phaseOf(node: ColorNode): Phase {
    if (!isGenerator(node.declaration)) return "all";
    return node.facet === "call" ? "eager" : "lazy";
  }

  function targetsOf(site: Transfer, body: Bodied): readonly Target[] {
    const known = targetsAt.get(site);
    if (known !== undefined) return known;
    const targets = calleeTargets(site, body, checker);
    targetsAt.set(site, targets);
    return targets;
  }

  /**
   * Every callee in `body`, paired with the transfer that reaches it. The one
   * walk all three readers of a body go through, so the dependency set, the
   * condition set and the escape list cannot disagree about what it does.
   */
  function targetsIn(body: Bodied, phase: Phase): readonly SiteTarget[] {
    const found: SiteTarget[] = [];
    for (const escape of escapesOf(body, phase)) {
      if (escape.kind !== "transfer") continue;
      for (const target of targetsOf(escape.node, body)) {
        found.push({ site: escape.node, target });
      }
    }
    return found;
  }

  /**
   * Every condition of one bodied callee, resolved at this site. An argument's
   * fate depends on the site and the path and nothing else, so it is worked out
   * once however many times the fixpoint asks.
   */
  function dischargesAt(
    site: Transfer,
    callee: BodiedTarget,
    body: Bodied,
    conditionsOf: Conditions,
  ): readonly Discharged[] {
    const byPath = outcomesAt.get(site) ?? new Map<string, readonly Outcome[]>();
    outcomesAt.set(site, byPath);

    return conditionsOf(callee.declaration).flatMap((condition) => {
      const key = pathKey(condition.path);
      let outcomes = byPath.get(key);
      if (outcomes === undefined) {
        outcomes = dischargeAt(site, condition, body, checker);
        byPath.set(key, outcomes);
      }
      return outcomes.map((outcome) => ({ condition, outcome }));
    });
  }

  /**
   * A class stands for a constructor it does not declare, and the implicit
   * `constructor(...args) { super(...args) }` still runs the base's effective
   * body. There is no `super()` in the syntax for the walk to have found.
   */
  function implicitSuper(body: Bodied): Target | undefined {
    if (!ts.isClassLike(body)) return undefined;
    const base = baseClassExpression(body);
    return base === undefined ? undefined : constructedTarget(base, checker);
  }

  /**
   * The condition set, resolved over the same graph as the color. It reads no
   * color, which is what keeps the two dimensions from chasing each other: a
   * path is a syntactic fact about which parameters a body enters, and only
   * whether the argument at one *can throw* needs a color.
   */
  const conditions = createFixpoint<Bodied, readonly Condition[]>({
    bottom: [],
    unresolved: [],
    dependenciesOf: (body) =>
      bodiedTargetsIn(body, "all").map(({ target }) => target.declaration),
    recompute: (body, conditionsOf) => {
      const derived = new Map<string, Condition>();
      const add = (path: Condition["path"], entry: Transfer): void => {
        const key = pathKey(path);
        if (!derived.has(key)) derived.set(key, { path, owner: body, entry });
      };

      for (const { site, target } of targetsIn(body, "all")) {
        if (target.kind === "condition") {
          add(target.path, site);
          continue;
        }
        if (target.kind !== "function") continue;
        for (const { outcome } of dischargesAt(site, target, body, conditionsOf)) {
          if (outcome.kind === "propagate") add(outcome.path, site);
        }
      }

      return [...derived.values()];
    },
    settled: samePaths,
  });

  const settledConditions: Conditions = (body) => conditions.valueOf(body);

  /**
   * Whether a color slot can throw. Pinned nodes cut this graph and do not
   * participate — marked seeds and floors alike — so what is walked is the
   * reachable unmarked subgraph, plus the arguments a condition makes it
   * depend on.
   */
  const throwing = createFixpoint<ColorNode, boolean>({
    bottom: false,
    unresolved: true,
    dependenciesOf,
    recompute: (node, throwingOf) =>
      producesByReturning(node)
        ? producedThrows(node.declaration, throwingOf)
        : bodyEscapes(node.declaration, phaseOf(node), throwingOf).length > 0 ||
          (node.facet === "call" &&
            implicitSuperThrows(node.declaration, throwingOf)),
    settled: (a, b) => a === b,
  });

  /**
   * Whether this slot's color comes from what the body returns rather than from
   * what it runs. A generator *is* its iterator; a plain function only hands
   * one on.
   */
  function producesByReturning(node: ColorNode): boolean {
    return node.facet === "iteration" && !isGenerator(node.declaration);
  }

  function dependenciesOf(node: ColorNode): readonly ColorNode[] {
    const { declaration } = node;

    if (producesByReturning(node)) {
      return returnedExpressions(declaration).flatMap((expression) =>
        colorNodesIn(producedBy(expression, declaration)),
      );
    }

    const dependencies: ColorNode[] = [];
    const phase = phaseOf(node);

    if (node.facet === "call") {
      const followed = implicitSuper(declaration);
      if (followed?.kind === "function" && !followed.marked) {
        dependencies.push(nodeFor(followed.declaration, "call"));
      }
    }

    for (const { site, target } of bodiedTargetsIn(declaration, phase)) {
      if (!target.marked) dependencies.push(nodeFor(target.declaration, "call"));
      for (const { outcome } of dischargesAt(
        site,
        target,
        declaration,
        settledConditions,
      )) {
        if (outcome.kind === "function" && !outcome.marked) {
          dependencies.push(nodeFor(outcome.declaration, "call"));
        }
      }
    }

    for (const escape of escapesOf(declaration, phase)) {
      if (escape.kind !== "consumption") continue;
      dependencies.push(...colorNodesIn(consumedBy(escape.site, declaration)));
    }

    return dependencies;
  }

  /**
   * Whether the implicit `constructor(...args) { super(...args) }` reaches
   * something throwing. It has no node in the syntax, so it can only color the
   * class: there is nowhere to anchor a diagnostic, and `new C()` is where the
   * reader is told. A conditioned base is undischargeable from here too — the
   * arguments it would be answered with are the ones the implicit constructor
   * forwards, and no parameter list was written to name them.
   */
  function implicitSuperThrows(
    body: Bodied,
    throwingOf: (callee: ColorNode) => boolean,
  ): boolean {
    const target = implicitSuper(body);
    if (target === undefined) return false;
    if (target.kind !== "function") return true;
    return (
      flooredCallee(target, throwingOf) !== undefined ||
      conditions.valueOf(target.declaration).length > 0
    );
  }

  function bodiedTargetsIn(
    body: Bodied,
    phase: Phase,
  ): { site: Transfer; target: BodiedTarget }[] {
    const found: { site: Transfer; target: BodiedTarget }[] = [];
    for (const { site, target } of targetsIn(body, phase)) {
      if (target.kind === "function") found.push({ site, target });
    }
    return found;
  }

  function bodyEscapes(
    body: Bodied,
    phase: Phase,
    throwingOf: (callee: ColorNode) => boolean,
  ): readonly BodyEscape[] {
    const found: BodyEscape[] = [];

    for (const escape of escapesOf(body, phase)) {
      if (escape.kind === "throw") {
        found.push({ kind: "throw", node: escape.node });
        continue;
      }
      if (escape.kind === "iterator-throw") {
        found.push(escape);
        continue;
      }
      if (escape.kind === "consumption") {
        const reason = consumedReason(consumedBy(escape.site, body), throwingOf);
        if (reason !== undefined) {
          found.push({ kind: "consumption", node: escape.site.node, reason });
        }
        continue;
      }
      for (const target of targetsOf(escape.node, body)) {
        collect(found, escape.node, target, body, throwingOf);
      }
    }

    return found;
  }

  function collect(
    found: BodyEscape[],
    site: Transfer,
    target: Target,
    body: Bodied,
    throwingOf: (callee: ColorNode) => boolean,
  ): void {
    // A parameter this body enters is the body's own precondition, discharged
    // by whoever calls it — never an escape here.
    if (target.kind === "condition") return;

    if (target.kind === "floor") {
      found.push({ kind: "callee", node: site, reason: target.reason });
      return;
    }

    const floored = flooredCallee(target, throwingOf);
    if (floored !== undefined) {
      found.push({ kind: "callee", node: site, reason: floored });
      return;
    }

    for (const { condition, outcome } of dischargesAt(
      site,
      target,
      body,
      settledConditions,
    )) {
      const escape = undischarged(site, condition, outcome, throwingOf);
      if (escape !== undefined) found.push(escape);
    }
  }

  function flooredCallee(
    target: BodiedTarget,
    throwingOf: (callee: ColorNode) => boolean,
  ): ThrowingReason | undefined {
    if (target.marked) return undefined;
    if (policy === "declare") return "unmarked";
    return throwingOf(nodeFor(target.declaration, "call"))
      ? "inferred"
      : undefined;
  }

  function undischarged(
    site: Transfer,
    condition: Condition,
    outcome: Outcome,
    throwingOf: (callee: ColorNode) => boolean,
  ): BodyEscape | undefined {
    const floored = (reason: UndischargedReason): BodyEscape => ({
      kind: "argument-floored",
      node: site,
      condition,
      reason,
    });

    if (outcome.kind === "propagate") return undefined;
    if (outcome.kind === "floor") return floored(outcome.reason);

    if (!outcome.marked) {
      if (policy === "declare") return floored("unmarked");
      if (throwingOf(nodeFor(outcome.declaration, "call"))) {
        return { kind: "argument-throwing", node: site, condition };
      }
    }

    // An argument non-throwing only given conditions of its own needs its own
    // arguments to discharge them, and this site has none to offer.
    return conditions.valueOf(outcome.declaration).length > 0
      ? floored("conditioned")
      : undefined;
  }

  /**
   * What consuming a site enters, joined over every type the value can have: a
   * union runs whichever protocol the value turns out to carry, so resolving
   * one constituent would answer by coin toss.
   */
  function consumedBy(site: Consumption, body: Bodied): readonly Consumed[] {
    const known = consumedAt.get(site.node);
    if (known !== undefined) return known;

    const types = constituentsOf(
      checker.getTypeAtLocation(site.typeAt),
      checker,
    );
    const consumed = types.flatMap((type) =>
      constituentConsumed(site, type, body),
    );
    consumedAt.set(site.node, consumed);
    return consumed;
  }

  /**
   * The originating call answers first and answers for everything, because the
   * mark it carries is a promise about the whole surface; only where the syntax
   * names no call is the protocol resolved member by member.
   */
  function constituentConsumed(
    site: Consumption,
    type: ts.Type,
    body: Bodied,
  ): readonly Consumed[] {
    const iterator = isIteratorType(type, checker);
    const origin =
      site.source === undefined
        ? undefined
        : originatingCall(site.source, checker);

    if (iterator && origin !== undefined) {
      return targetsOf(origin, body).map((target) =>
        consumedFrom(target, "iteration"),
      );
    }

    const resolved = protocolConsumed(type, site.protocol);
    // An iterator's own protocol members are the standard library's, so
    // "declared without a body" would name a `.d.ts` the author never wrote.
    // What they can act on is the call that produced the value.
    const bodyless = resolved.some(
      (consumed) => consumed.kind === "floor" && consumed.reason === "bodyless",
    );
    return iterator && bodyless
      ? [floorConsumed(untracedReason(site.source, checker))]
      : resolved;
  }

  /** The protocol members a site runs, resolved through the static type. */
  function protocolConsumed(
    type: ts.Type,
    protocol: Protocol,
  ): readonly Consumed[] {
    if (protocol.kind === "member") {
      return [memberConsumed(type, protocol.name, "call")];
    }
    if (protocol.kind === "iterable") return iterableConsumed(type);

    // A returned iterator is consumed by code we cannot see, so every part of
    // its surface is in scope.
    const parts: Consumed[] = [];
    for (const name of ["next", "return"] as const) {
      if (protocolMember(type, name, checker) !== undefined) {
        parts.push(memberConsumed(type, name, "call"));
      }
    }
    if (protocolMember(type, "iterator", checker) !== undefined) {
      parts.push(...iterableConsumed(type));
    }
    return parts.length === 0 ? [floorConsumed("unresolvable")] : parts;
  }

  /** `[Symbol.iterator]()` runs, and what it hands back is driven to done. */
  function iterableConsumed(type: ts.Type): readonly Consumed[] {
    if (protocolMember(type, "iterator", checker) === undefined) {
      return [floorConsumed("unresolvable")];
    }
    return [
      memberConsumed(type, "iterator", "call"),
      memberConsumed(type, "iterator", "iteration"),
    ];
  }

  function memberConsumed(
    type: ts.Type,
    name: ProtocolMemberName,
    facet: Facet,
  ): Consumed {
    const member = protocolMember(type, name, checker);
    return member === undefined
      ? floorConsumed("unresolvable")
      : consumedFrom(declarationTarget(member), facet);
  }

  /**
   * One facet of a target, as something consuming it can enter. A callee
   * reached through a parameter is the one target this cannot follow: a
   * condition says the argument's *call* is clean, and there is no form for
   * "and consuming what it hands back is too", so it floors rather than passing
   * upward a question no caller could answer.
   */
  function consumedFrom(target: Target, facet: Facet): Consumed {
    if (target.kind === "condition") {
      return floorConsumed("conditioned-producer");
    }
    if (target.kind === "floor") return floorConsumed(target.reason);
    if (target.marked) return CONSUMED_CLEAN;
    if (policy === "declare") return floorConsumed("unmarked");
    return { kind: "color", node: nodeFor(target.declaration, facet) };
  }

  /** The whole surface of the iterator an expression denotes. */
  function producedBy(
    expression: ts.Expression,
    body: Bodied,
  ): readonly Consumed[] {
    return consumedBy(
      {
        node: expression,
        protocol: { kind: "iterator" },
        source: expression,
        typeAt: expression,
      },
      body,
    );
  }

  /**
   * A plain function's iterator is whatever it returns, and consuming that is
   * what consuming this one is. Every return counts, unfiltered: a branch
   * handing back something that is not an iterator is a question with no answer
   * rather than one to skip.
   */
  function producedThrows(
    declaration: Bodied,
    throwingOf: (callee: ColorNode) => boolean,
  ): boolean {
    const returned = returnedExpressions(declaration);
    if (returned.length === 0) return true;
    return returned.some(
      (expression) =>
        consumedReason(producedBy(expression, declaration), throwingOf) !==
        undefined,
    );
  }

  /** Why consuming this escapes, or nothing where no part of it can throw. */
  function consumedReason(
    consumed: readonly Consumed[],
    throwingOf: (callee: ColorNode) => boolean,
  ): ConsumptionReason | undefined {
    for (const part of consumed) {
      if (part.kind === "floor") return part.reason;
    }
    return consumed.some(
      (part) => part.kind === "color" && throwingOf(part.node),
    )
      ? "inferred"
      : undefined;
  }

  return {
    escapesIn(body) {
      const throwingOf = (callee: ColorNode): boolean =>
        throwing.valueOf(callee);
      // A mark covers both surfaces, so enforcement reads the whole body
      // however lazily a call reaches it, and asks after the iterator the body
      // hands out on top of that.
      return [
        ...bodyEscapes(body, "all", throwingOf),
        ...returnedIterators(body, throwingOf),
      ];
    },
  };

  /**
   * The iterators a body hands out, which a mark on it covers consuming — so a
   * mark on a plain function returning one it cannot trace to a clean producer
   * is refused, per the doctrine that unprovable is not clean. A generator
   * needs no such check: its iterator *is* the body already walked.
   */
  function returnedIterators(
    body: Bodied,
    throwingOf: (callee: ColorNode) => boolean,
  ): readonly BodyEscape[] {
    if (isGenerator(body)) return [];

    const found: BodyEscape[] = [];
    for (const expression of returnedExpressions(body)) {
      if (!isIteratorType(checker.getTypeAtLocation(expression), checker)) {
        continue;
      }
      const reason = consumedReason(producedBy(expression, body), throwingOf);
      if (reason !== undefined) {
        found.push({ kind: "returned-iterator", node: expression, reason });
      }
    }
    return found;
  }
}

function floorConsumed(reason: ConsumptionReason): Consumed {
  return { kind: "floor", reason };
}

function colorNodesIn(consumed: readonly Consumed[]): readonly ColorNode[] {
  return consumed.flatMap((part) => (part.kind === "color" ? [part.node] : []));
}

/**
 * Which half of "no originating call" this is. A `let` is a refinement the
 * engine has not made yet, exactly as it is for a callee; anything else is a
 * question the syntax cannot answer, and the fix is to bridge.
 */
function untracedReason(
  source: ts.Expression | undefined,
  checker: ts.TypeChecker,
): ConsumptionReason {
  if (source === undefined || !ts.isIdentifier(source)) return "untraced";
  const declaration = checker.getSymbolAtLocation(source)?.valueDeclaration;
  return declaration !== undefined && ts.isVariableDeclaration(declaration)
    ? "mutable-binding"
    : "untraced";
}

function samePaths(a: readonly Condition[], b: readonly Condition[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(b.map((condition) => pathKey(condition.path)));
  return a.every((condition) => keys.has(pathKey(condition.path)));
}

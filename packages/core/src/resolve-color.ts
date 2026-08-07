import ts from "typescript";
import type {
  ConsumptionReason,
  RejectionReason,
  ThrowingReason,
  UndischargedReason,
} from "./colors.js";
import { pathKey, skipParens, type Condition } from "./conditions.js";
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
  chainAt,
  isPromiseType,
  isVisiblyAsync,
  type Chain,
} from "./promises.js";
import {
  calleeTargets,
  constructedTarget,
  declarationTarget,
  declaredTarget,
  resolveValue,
  type DeclaredTarget,
  type Target,
} from "./targets.js";
import {
  hiddenTransfersOf,
  type HiddenCallee,
  type TransferSite,
} from "./transfers.js";

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
    }
  /** `await`: where a rejection becomes a throw in the awaiting body. */
  | {
      readonly kind: "rejected-await";
      readonly node: ts.AwaitExpression;
      readonly reason: RejectionReason;
    }
  /**
   * A promise dropped in statement position. `fake` says the author wrapped it
   * in a `try`/`catch` that can never fire, which is a different thing to be
   * told than that the promise floats.
   */
  | {
      readonly kind: "float";
      readonly node: ts.Expression;
      readonly reason: RejectionReason;
      readonly fake: boolean;
    }
  /** A promise handed out, whose rejection the mark covers. */
  | {
      readonly kind: "rejected-return";
      readonly node: ts.Expression;
      readonly reason: RejectionReason;
    }
  /**
   * A body that runs with no callee in the syntax: an accessor behind a
   * property access, a conversion member behind a coercion. Its own kind
   * because what the reader has to be told is different — not "this call
   * throws" but "this is a call".
   */
  | {
      readonly kind: "hidden-transfer";
      readonly node: ts.Node;
      readonly site: TransferSite;
      /** The site as written. */
      readonly text: string;
      /** Absent when the type could not name what runs, which always floors. */
      readonly target: HiddenCallee | undefined;
      readonly reason: ThrowingReason;
    };

/**
 * The color-resolution seam. Every "what color is this callee?" question goes
 * through here, so inference and the resolver chain — overrides, overlays,
 * shipped manifests, the baseline — land behind this one object instead of
 * being threaded through the walk. Hidden transfers ask it the same question
 * about a body the syntax never named.
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

/**
 * What rejecting the promise an expression denotes would take. A tree rather
 * than a joined list because one row of the fold table is not a join:
 * `X.catch(b)` runs `b` only if `X` rejects, so whether `b`'s color counts is a
 * question about `X` that only the fixpoint can answer.
 */
type Rejection =
  | { readonly kind: "clean" }
  | { readonly kind: "color"; readonly node: ColorNode }
  | { readonly kind: "floor"; readonly reason: RejectionReason }
  | { readonly kind: "join"; readonly parts: readonly Rejection[] }
  | {
      readonly kind: "discharged";
      readonly source: Rejection;
      readonly handler: Rejection;
    };

const REJECTION_CLEAN: Rejection = { kind: "clean" };

/** One body a hidden transfer can enter, named the way a message wants it. */
interface HiddenTarget {
  /** Absent when the type could not name what runs. */
  readonly named: HiddenCallee | undefined;
  readonly target: DeclaredTarget;
}

/** One hidden call site, with every body it can enter resolved. */
interface HiddenSite {
  readonly node: ts.Node;
  readonly site: TransferSite;
  readonly text: string;
  readonly targets: readonly HiddenTarget[];
}

export function createColorResolver(checker: ts.TypeChecker): ColorResolver {
  const policy = colorPolicy();

  const walks = new Map<Bodied, Map<Phase, readonly Escape[]>>();

  /**
   * The hidden transfers at one escape site. Keyed by the site rather than the
   * body because the walk hands back the same `Escape` objects every time, and
   * resolving one is checker work the fixpoint would otherwise repeat.
   */
  const hiddenAt = memoize(
    (escape: Escape): readonly HiddenSite[] =>
      hiddenTransfersOf(escape, checker).map((transfer) => ({
        node: transfer.node,
        site: transfer.site,
        text: transfer.text,
        targets: transfer.targets.map((entry) => ({
          named: entry.target,
          target: declaredTarget(entry.declaration),
        })),
      })),
  );

  function hiddenIn(body: Bodied, phase: Phase): readonly HiddenSite[] {
    return escapesOf(body, phase).flatMap((escape) => hiddenAt(escape));
  }


  const targetsAt = new Map<Transfer, readonly Target[]>();
  const outcomesAt = new Map<Transfer, Map<string, readonly Outcome[]>>();
  const consumedAt = new Map<ts.Node, readonly Consumed[]>();
  const rejectionAt = new Map<ts.Expression, Rejection>();
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
      if (escape.kind !== "call") continue;
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
        for (const { outcome } of dischargesAt(
          site,
          target,
          body,
          conditionsOf,
        )) {
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

    // Awaiting, discarding and returning a promise each read a color the same
    // way a call does; only the channel the throw arrives on is different.
    for (const rejection of rejectionsIn(declaration, phase)) {
      dependencies.push(...rejectionNodes(rejection));
    }

    // An accessor's body is read like any other callee's; only the syntax
    // reaching it is different.
    for (const { targets } of hiddenIn(declaration, phase)) {
      for (const { target } of targets) {
        if (target.kind === "function" && !target.marked) {
          dependencies.push(nodeFor(target.declaration, "call"));
        }
      }
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
      if (escape.kind === "await") {
        const reason = rejectionReason(
          rejectionOf(escape.node.expression, body),
          throwingOf,
        );
        if (reason !== undefined) {
          found.push({ kind: "rejected-await", node: escape.node, reason });
        }
        continue;
      }
      if (escape.kind === "float") {
        const reason = rejectionReason(
          rejectionOf(escape.node, body),
          throwingOf,
        );
        if (reason !== undefined) {
          found.push({
            kind: "float",
            node: escape.node,
            reason,
            fake: escape.bridged && cannotFire(escape.node, body),
          });
        }
        continue;
      }
      if (escape.kind === "call") {
        for (const target of targetsOf(escape.node, body)) {
          collect(found, escape.node, target, body, throwingOf);
        }
      }
      // A call can hide transfers of its own: the tag of a tagged template, a
      // coercion in an argument. They are read off the same site.
      for (const hidden of hiddenAt(escape)) {
        collectHidden(found, hidden, throwingOf);
      }
    }

    if (phase !== "eager") found.push(...rejectedReturns(body, throwingOf));

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

    // `then`, `catch` and `finally` are the fold table's, not the call rule's.
    // Reading them as ordinary calls would floor every chain on the standard
    // library's bodyless declaration and never reach the handlers, which are
    // where a chain's color actually comes from.
    if (chainAt(site, checker) !== undefined) return;

    if (target.kind === "floor") {
      if (!awaitedDirectly(site)) {
        found.push({ kind: "callee", node: site, reason: target.reason });
      }
      return;
    }

    const floored = flooredCallee(target, throwingOf);
    if (floored !== undefined) {
      // The sync channel, and only it. A visibly-`async` callee cannot
      // sync-throw, so what it can do is read at the `await`, the chain or the
      // discard instead; and where the call *is* the awaited expression, the
      // `await` is already the one site for both channels.
      if (!isVisiblyAsync(target.declaration) && !awaitedDirectly(site)) {
        found.push({ kind: "callee", node: site, reason: floored });
      }
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

  /**
   * A hidden site's targets are joined: it is throwing if any of them is, and
   * the first that is answers for it — one site, one diagnostic, however many
   * members a dynamic key or a spread turned out to touch.
   */
  function collectHidden(
    found: BodyEscape[],
    hidden: HiddenSite,
    throwingOf: (callee: ColorNode) => boolean,
  ): void {
    for (const { named, target } of hidden.targets) {
      const reason = hiddenReason(target, throwingOf);
      if (reason === undefined) continue;
      found.push({
        kind: "hidden-transfer",
        node: hidden.node,
        site: hidden.site,
        text: hidden.text,
        target: named,
        reason,
      });
      return;
    }
  }

  function hiddenReason(
    target: DeclaredTarget,
    throwingOf: (callee: ColorNode) => boolean,
  ): ThrowingReason | undefined {
    if (target.kind === "floor") return target.reason;

    const floored = flooredCallee(target, throwingOf);
    if (floored !== undefined) return floored;

    // The site reaches this body through a type rather than handing it over,
    // so a condition on it has no argument here that could discharge one.
    return conditions.valueOf(target.declaration).length > 0
      ? "conditioned"
      : undefined;
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

    const resolved = protocolConsumed(type, site.protocol, site.async);
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
    async: boolean,
  ): readonly Consumed[] {
    if (protocol.kind === "member") {
      return [memberConsumed(type, protocol.name, "call", async)];
    }
    if (protocol.kind === "iterable") return iterableConsumed(type, async);

    // A returned iterator is consumed by code we cannot see, so every part of
    // its surface is in scope — and whichever spelling of the protocol it
    // carries, since the consumer picks and we do not see them pick.
    const parts: Consumed[] = [];
    for (const name of ["next", "return"] as const) {
      if (protocolMember(type, name, checker, true) !== undefined) {
        parts.push(memberConsumed(type, name, "call", true));
      }
    }
    if (protocolMember(type, "iterator", checker, true) !== undefined) {
      parts.push(...iterableConsumed(type, true));
    }
    return parts.length === 0 ? [floorConsumed("unresolvable")] : parts;
  }

  /** `[Symbol.iterator]()` runs, and what it hands back is driven to done. */
  function iterableConsumed(
    type: ts.Type,
    async: boolean,
  ): readonly Consumed[] {
    if (protocolMember(type, "iterator", checker, async) === undefined) {
      return [floorConsumed("unresolvable")];
    }
    return [
      memberConsumed(type, "iterator", "call", async),
      memberConsumed(type, "iterator", "iteration", async),
    ];
  }

  function memberConsumed(
    type: ts.Type,
    name: ProtocolMemberName,
    facet: Facet,
    async: boolean,
  ): Consumed {
    const member = protocolMember(type, name, checker, async);
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
        async: true,
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

  /**
   * What the promise an expression denotes would reject with. Reject-ness is
   * not something TypeScript computes, so it rides the same color the sync
   * channel does — which is what makes `@nothrow` one mark over the whole
   * consumption surface rather than two.
   */
  function rejectionOf(expression: ts.Expression, body: Bodied): Rejection {
    const known = rejectionAt.get(expression);
    if (known !== undefined) return known;
    const rejection = resolveRejection(expression, body);
    rejectionAt.set(expression, rejection);
    return rejection;
  }

  function resolveRejection(expr: ts.Expression, body: Bodied): Rejection {
    const expression = skipParens(expr);
    // Nothing that is not a promise can reject, and saying so here is what
    // keeps every site that asks free of the question.
    if (!isPromiseType(checker.getTypeAtLocation(expression), checker)) {
      return REJECTION_CLEAN;
    }

    const chain = chainAt(expression, checker);
    if (chain !== undefined) return foldChain(chain, body);

    const origin = originatingCall(expression, checker);
    if (origin === undefined) return floorRejection(untracedRejection(expression));
    // The fold is syntactic. A chain reached through a binding is a stored
    // partial chain, and folding it would be claiming the handlers written
    // somewhere else are the ones this value carries.
    if (origin !== expression && chainAt(origin, checker) !== undefined) {
      return floorRejection("untraced");
    }

    return joinRejections(
      targetsOf(origin, body).map((target) =>
        rejectedFrom(target, "conditioned-producer"),
      ),
    );
  }

  /**
   * One row of the normative fold table. `then` with a second handler is the
   * one link that drops its source: `b` is on the rejection path, so whatever
   * the source did is answered for.
   */
  function foldChain(chain: Chain, body: Bodied): Rejection {
    const { link } = chain;
    const source = (): Rejection => rejectionOf(chain.source, body);
    const handler = (argument: ts.Expression | undefined): Rejection =>
      handlerRejection(argument, body);

    if (link.kind === "finally") {
      return joinRejections([source(), handler(link.onFinally)]);
    }
    if (link.kind === "catch") {
      return {
        kind: "discharged",
        source: source(),
        handler: handler(link.onRejected),
      };
    }
    return link.onRejected === undefined
      ? joinRejections([source(), handler(link.onFulfilled)])
      : joinRejections([handler(link.onFulfilled), handler(link.onRejected)]);
  }

  /**
   * A chain handler is an ordinary function: an inline arrow is inferred, a
   * reference is resolved, and an opaque one floors the link.
   */
  function handlerRejection(
    argument: ts.Expression | undefined,
    body: Bodied,
  ): Rejection {
    if (argument === undefined) return REJECTION_CLEAN;

    const resolved = resolveValue(argument, body, checker);
    if (resolved.kind === "mutable") return floorRejection("mutable-binding");
    if (resolved.kind === "unknown") return floorRejection("unresolvable");
    return joinRejections(
      resolved.targets.map((target) =>
        rejectedFrom(target, "conditioned-handler"),
      ),
    );
  }

  /**
   * A target as something whose promise can reject. `whenConditioned` is what
   * a parameter means here, which differs by position: reaching the *producer*
   * through one leaves the promise uncolorable, while reaching a *handler*
   * through one is a mechanism the engine does not have.
   */
  function rejectedFrom(
    target: Target,
    whenConditioned: RejectionReason,
  ): Rejection {
    if (target.kind === "condition") return floorRejection(whenConditioned);
    if (target.kind === "floor") return floorRejection(target.reason);
    if (target.marked) return REJECTION_CLEAN;
    if (policy === "declare") return floorRejection("unmarked");
    return { kind: "color", node: nodeFor(target.declaration, "call") };
  }

  /**
   * Which half of "no originating call" this is — the distinction #12 §7 makes
   * the message carry: a `let` is a refinement not yet made, and everything
   * else is unknowable from here and has to be bridged.
   */
  function untracedRejection(expression: ts.Expression): RejectionReason {
    if (!ts.isIdentifier(expression)) return "untraced";
    const declaration =
      checker.getSymbolAtLocation(expression)?.valueDeclaration;
    return declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
      ? "mutable-binding"
      : "untraced";
  }

  /** Why this promise can reject, or nothing where no part of it can. */
  function rejectionReason(
    rejection: Rejection,
    throwingOf: (callee: ColorNode) => boolean,
  ): RejectionReason | undefined {
    switch (rejection.kind) {
      case "clean":
        return undefined;
      case "floor":
        return rejection.reason;
      case "color":
        return throwingOf(rejection.node) ? "inferred" : undefined;
      case "join": {
        // A floor outranks a read body: it is the one the reader can act on
        // with something other than a bridge.
        const reasons = rejection.parts.flatMap((part) => {
          const reason = rejectionReason(part, throwingOf);
          return reason === undefined ? [] : [reason];
        });
        return reasons.find((reason) => reason !== "inferred") ?? reasons[0];
      }
      case "discharged":
        return rejectionReason(rejection.source, throwingOf) === undefined
          ? undefined
          : rejectionReason(rejection.handler, throwingOf);
    }
  }

  /**
   * The promises a body hands out, whose rejection a mark on it covers: an
   * uncaught `throw` in an `async` body is a rejection of its own promise, and
   * `return <expr>` folds whatever `expr` would reject with into it.
   */
  function rejectedReturns(
    body: Bodied,
    throwingOf: (callee: ColorNode) => boolean,
  ): readonly BodyEscape[] {
    if (isGenerator(body)) return [];

    const found: BodyEscape[] = [];
    for (const expression of returnedExpressions(body)) {
      const reason = rejectionReason(
        rejectionOf(expression, body),
        throwingOf,
      );
      if (reason !== undefined) {
        found.push({ kind: "rejected-return", node: expression, reason });
      }
    }
    return found;
  }

  /** Every color a rejection can turn on, so the fixpoint can order them. */
  function rejectionNodes(rejection: Rejection): readonly ColorNode[] {
    switch (rejection.kind) {
      case "clean":
      case "floor":
        return [];
      case "color":
        return [rejection.node];
      case "join":
        return rejection.parts.flatMap(rejectionNodes);
      case "discharged":
        return [
          ...rejectionNodes(rejection.source),
          ...rejectionNodes(rejection.handler),
        ];
    }
  }

  /** The rejections one escape site turns on, whichever kind of site it is. */
  function rejectionsIn(
    body: Bodied,
    phase: Phase,
  ): readonly Rejection[] {
    const found: Rejection[] = [];

    for (const escape of escapesOf(body, phase)) {
      if (escape.kind === "await") {
        found.push(rejectionOf(escape.node.expression, body));
      } else if (escape.kind === "float") {
        found.push(rejectionOf(escape.node, body));
      }
    }

    if (phase !== "eager" && !isGenerator(body)) {
      for (const expression of returnedExpressions(body)) {
        found.push(rejectionOf(expression, body));
      }
    }

    return found;
  }

  /**
   * Whether the `await` written on this call is the site that answers for it.
   * The two channels are neutralized by exactly the same `try` there, so one
   * diagnostic covers both — and `try { await f() } catch` is the bridge that
   * works whether or not the callee is `async`.
   */
  function awaitedDirectly(site: Transfer): boolean {
    let node: ts.Node = site;
    while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
    return (
      ts.isAwaitExpression(node.parent) &&
      isPromiseType(checker.getTypeAtLocation(site), checker)
    );
  }

  /**
   * Whether a `try`/`catch` around this discard can catch anything at all. A
   * visibly-`async` callee never throws — it rejects — so a `catch` with no
   * `await` is not on the path, and telling the reader that is a different
   * thing from telling them the promise floats.
   */
  function cannotFire(expression: ts.Expression, body: Bodied): boolean {
    if (!ts.isCallExpression(expression)) return false;
    const targets = targetsOf(expression, body);
    return (
      targets.length > 0 &&
      targets.every(
        (target) =>
          target.kind === "function" && isVisiblyAsync(target.declaration),
      )
    );
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

function floorRejection(reason: RejectionReason): Rejection {
  return { kind: "floor", reason };
}

/** A join of one is that one: a tree with no branch reads better in a message. */
function joinRejections(parts: readonly Rejection[]): Rejection {
  if (parts.length === 1) return parts[0] as Rejection;
  return { kind: "join", parts };
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

function memoize<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>();
  return (key) => {
    const known = cache.get(key);
    if (known !== undefined) return known;
    const value = compute(key);
    cache.set(key, value);
    return value;
  };
}

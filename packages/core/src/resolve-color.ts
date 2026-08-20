import ts from "typescript";
import type {
  AbsenceReason,
  ConsumptionReason,
  FloorReason,
  FloorSource,
  Rejects,
  RejectionReason,
  RejectionSubject,
  ThrowingReason,
  UndischargedReason,
} from "./colors.js";
import {
  conditionKey,
  pathKey,
  skipParens,
  type Condition,
} from "./conditions.js";
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
  constructedTargets,
  declarationTarget,
  declaredTarget,
  resolveValue,
  type DeclaredTarget,
  type Resolution,
  type Target,
} from "./targets.js";
import {
  hiddenTransfersOf,
  type HiddenCallee,
  type TransferColor,
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
      /**
       * The body read is a class that declares no constructor of its own, so
       * there is no declaration a mark could bind to and "mark it" is not an
       * out. Only an inferred reason ever offers one.
       */
      readonly constructorless?: boolean;
      /** The file whose hash drifted; only `stale-manifest` carries one. */
      readonly staleFile?: string | undefined;
      /** Absent where the callee is not a standard-library declaration. */
      readonly source?: FloorSource | undefined;
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
      readonly staleFile?: string | undefined;
      /** Absent where the argument is not a standard-library declaration. */
      readonly source?: FloorSource | undefined;
    }
  /**
   * A condition asking for no argument at the position, and a call that puts
   * one there. The remedy is to stop passing rather than to pass something
   * else, so what floored is the *call* — which is why the source here is the
   * callee's declaration and not the argument's.
   */
  | {
      readonly kind: "argument-present";
      readonly node: Transfer;
      readonly condition: Condition;
      readonly reason: AbsenceReason;
      readonly source?: FloorSource | undefined;
    }
  /** A `for…of`, spread, destructuring, `.next()` or `yield*`. */
  | {
      readonly kind: "consumption";
      readonly node: ts.Node;
      readonly reason: ConsumptionReason;
      readonly staleFile?: string | undefined;
      readonly source?: FloorSource | undefined;
    }
  /** `.throw()`: the consumer throwing, with a detour through the iterator. */
  | { readonly kind: "iterator-throw"; readonly node: ts.Node }
  /** An iterator handed out, which the mark covers consuming. */
  | {
      readonly kind: "returned-iterator";
      readonly node: ts.Expression;
      readonly reason: ConsumptionReason;
      readonly staleFile?: string | undefined;
      readonly source?: FloorSource | undefined;
    }
  /**
   * A rejection reaching the body: at an `await`, at a statement-position
   * discard, or at a `return` folding it into this function's own promise.
   * `fake` says the discard sits in a `try`/`catch` that can never fire, which
   * is a different thing to be told than that the promise floats.
   */
  | {
      readonly kind: "rejected-await" | "float" | "rejected-return";
      readonly node: ts.Node;
      readonly rejects: Rejects;
      readonly fake: boolean;
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
      readonly staleFile?: string | undefined;
      readonly source?: FloorSource | undefined;
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
  /**
   * The paths over `body`'s own parameters it is non-throwing given, settled.
   * The enforcement walk never asks — a condition is the lattice it works in —
   * but a carrier writing the color down has to record it positively, because
   * absence on the wire means maximally conditioned.
   */
  conditionsIn(body: Bodied): readonly Condition[];
}

/**
 * A generator's call and its iterator are two colors over one body — the call
 * runs the parameter list, consumption runs everything else — so what the
 * throwing dimension colors is a facet of a declaration rather than the
 * declaration itself. For every other function kind the call facet is the whole
 * body, and the iteration facet is whatever its `return` hands back.
 *
 * Conditions need no facets on either side. Which parameters a body enters is
 * one fact about it whenever the entering happens, and the call is where the
 * argument that will be entered is fixed either way; and what a condition
 * *demands* is the whole surface rather than a facet of it, since non-throwing
 * is one color over all of it.
 */
type Facet = "call" | "iteration";

interface ColorNode {
  readonly declaration: Bodied;
  readonly facet: Facet;
}

/** A callee with source behind it, which is what inference reads. */
type BodiedTarget = Extract<Target, { kind: "function" }>;

/** A callee that can carry conditions: one with a body, or one with an entry. */
type ConditionedTarget = Extract<Target, { kind: "function" | "carried" }>;

/** A callee the carrier chain answered for rather than the program. */
type CarriedTarget = Extract<Target, { kind: "carried" }>;

/**
 * Why entering a carried callee escapes, or nothing where the carrier says it
 * does not. Every site that meets one asks these two questions in this order;
 * only the shape each wraps the answer in differs.
 */
function carriedReason(target: CarriedTarget): FloorReason | undefined {
  if (target.color === "throwing") return "carried-throwing";
  // Clean given conditions of its own, reached through a type rather than
  // handed anything: nothing here could discharge them.
  return target.conditions.length > 0 ? "conditioned" : undefined;
}

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
  | {
      readonly kind: "floor";
      readonly reason: ConsumptionReason;
      readonly staleFile?: string | undefined;
      readonly source?: FloorSource | undefined;
    };

const CONSUMED_CLEAN: Consumed = { kind: "clean" };

/**
 * What rejecting the promise an expression denotes would take. A tree rather
 * than a joined list because one row of the fold table is not a join:
 * `X.catch(b)` runs `b` only if `X` rejects, so whether `b`'s color counts is a
 * question about `X` that only the fixpoint can answer.
 */
type Rejection =
  | { readonly kind: "clean" }
  | {
      readonly kind: "color";
      readonly node: ColorNode;
      readonly subject: RejectionSubject;
    }
  | {
      readonly kind: "floor";
      readonly reason: RejectionReason;
      readonly subject: RejectionSubject;
      readonly staleFile?: string | undefined;
      readonly source?: FloorSource | undefined;
    }
  | { readonly kind: "join"; readonly parts: readonly Rejection[] }
  | {
      readonly kind: "discharged";
      readonly source: Rejection;
      readonly handler: Rejection;
    };

const REJECTION_CLEAN: Rejection = { kind: "clean" };

/**
 * Where a promise's own channel is consumed, and so where it can escape. One
 * list serves both readers — the fixpoint's dependency set and the findings —
 * for the same reason `targetsIn` does: two walks over the same sites can fall
 * out of step, and a dependency the fixpoint never ordered is a soundness bug
 * rather than a slow path.
 */
interface RejectionSite {
  readonly kind: "await" | "float" | "return";
  /** Where the diagnostic lands. */
  readonly node: ts.Node;
  readonly rejection: Rejection;
  /** The discard sits in a `try`/`catch` whose `catch` can never fire. */
  readonly fake: boolean;
}

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

export function createColorResolver(resolution: Resolution): ColorResolver {
  const { checker } = resolution;
  const policy = colorPolicy();

  const walks = new Map<Bodied, Map<Phase, readonly Escape[]>>();

  /**
   * The hidden transfers at one escape site. Keyed by the site rather than the
   * body because the walk hands back the same `Escape` objects every time, and
   * resolving one is checker work the fixpoint would otherwise repeat.
   */
  const hiddenAt = memoize(
    (escape: Escape): readonly HiddenSite[] =>
      hiddenTransfersOf(escape, resolution).map((transfer) => ({
        node: transfer.node,
        site: transfer.site,
        text: transfer.text,
        targets: transfer.targets.map((entry) => ({
          named: entry.target,
          target: hiddenColor(entry.color),
        })),
      })),
  );

  /**
   * What colors one half of one hidden site. An accessor fact colors a half of
   * a member the declaration says is data, so there is no body behind it to
   * read — the fact is all of it — and a lib member with no fact has neither.
   */
  function hiddenColor(color: TransferColor): DeclaredTarget {
    if (color.kind === "floor") {
      return { kind: "floor", reason: color.reason, source: color.source };
    }
    if (color.kind === "carried") {
      return {
        kind: "carried",
        color: color.color,
        async: false,
        conditions: [],
        source: color.source,
      };
    }
    return declaredTarget(color.declaration, resolution);
  }

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
    const targets = calleeTargets(site, body, resolution);
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
    conditions: readonly Condition[],
    body: Bodied,
  ): readonly Discharged[] {
    const byPath = outcomesAt.get(site) ?? new Map<string, readonly Outcome[]>();
    outcomesAt.set(site, byPath);

    return conditions.flatMap((condition) => {
      const key = conditionKey(condition);
      let outcomes = byPath.get(key);
      if (outcomes === undefined) {
        outcomes = dischargeAt(site, condition, body, resolution);
        byPath.set(key, outcomes);
      }
      return outcomes.map((outcome) => ({ condition, outcome }));
    });
  }

  /**
   * Every condition one callee carries. A body's are read off the fixpoint; a
   * carrier's are written down, and both are discharged by the same join at the
   * same call site — which is the whole point of recording them positively.
   */
  function conditionsOfTarget(
    target: ConditionedTarget,
    conditionsOf: Conditions,
  ): readonly Condition[] {
    return target.kind === "carried"
      ? target.conditions
      : conditionsOf(target.declaration);
  }

  /**
   * A class stands for a constructor it does not declare, and the implicit
   * `constructor(...args) { super(...args) }` still runs the base's effective
   * body. There is no `super()` in the syntax for the walk to have found — and
   * so no argument list to pick an overload with, which is why a base known
   * only by its construct signatures answers with all of them.
   */
  const implicitSupers = memoize((body: Bodied): readonly Target[] => {
    if (!ts.isClassLike(body)) return [];
    const base = baseClassExpression(body);
    return base === undefined ? [] : constructedTargets(base, resolution);
  });

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
      conditionedTargetsIn(body, "all").flatMap(({ target }) =>
        target.kind === "function" ? [target.declaration] : [],
      ),
    recompute: (body, conditionsOf) => {
      const derived = new Map<string, Condition>();
      // Only `entered` is ever derived: an absence condition is a claim about
      // a body nobody can read, and propagation carries a path onward rather
      // than the absence of one.
      const add = (path: Condition["path"], entry: Transfer): void => {
        const key = pathKey(path);
        if (!derived.has(key)) {
          derived.set(key, { requires: "entered", path, owner: body, entry });
        }
      };

      for (const { site, target } of targetsIn(body, "all")) {
        if (target.kind === "condition") {
          add(target.path, site);
          continue;
        }
        if (target.kind !== "function" && target.kind !== "carried") continue;
        for (const { outcome } of dischargesAt(
          site,
          conditionsOfTarget(target, conditionsOf),
          body,
        )) {
          if (outcome.kind === "propagate") add(outcome.path, site);
        }
      }

      return [...derived.values()];
    },
    settled: sameConditions,
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

  /**
   * Whether consuming what a callee hands back is a question with an answer.
   * A generator *is* its iterator; anything else produces one only where what
   * it returns carries the protocol. Asked because the iteration facet of a
   * callee that hands back nothing consumable is not silence: `producedThrows`
   * reads a return that is not an iterator as a hazard, which is what a real
   * consumption site needs and what a demand made sight unseen must not meet.
   */
  const producesConsumable = memoize((declaration: Bodied): boolean => {
    if (isGenerator(declaration)) return true;
    if (ts.isClassLike(declaration)) return false;
    const signature = checker.getSignatureFromDeclaration(declaration);
    if (signature === undefined) return false;
    return constituentsOf(signature.getReturnType(), checker).some(
      (type) =>
        isIteratorType(type, checker) ||
        protocolMember(type, "iterator", checker, true) !== undefined,
    );
  });

  /**
   * Every color a callee's whole surface is made of. One color, full surface:
   * `@nothrow` is a promise about calling it *and* about consuming what it
   * hands back, so anything demanding a callee be non-throwing has to read
   * both — which is what lets a condition stand in for the surface at a site
   * that only holds the argument.
   */
  function surfaceNodes(declaration: Bodied): readonly ColorNode[] {
    const call = nodeFor(declaration, "call");
    return producesConsumable(declaration)
      ? [call, nodeFor(declaration, "iteration")]
      : [call];
  }

  function surfaceThrows(
    declaration: Bodied,
    throwingOf: (callee: ColorNode) => boolean,
  ): boolean {
    return surfaceNodes(declaration).some(throwingOf);
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
      for (const followed of implicitSupers(declaration)) {
        if (followed.kind === "function" && !followed.marked) {
          dependencies.push(nodeFor(followed.declaration, "call"));
        }
      }
    }

    for (const { site, target } of conditionedTargetsIn(declaration, phase)) {
      if (target.kind === "function" && !target.marked) {
        dependencies.push(nodeFor(target.declaration, "call"));
      }
      for (const { outcome } of dischargesAt(
        site,
        conditionsOfTarget(target, settledConditions),
        declaration,
      )) {
        if (outcome.kind === "function" && !outcome.marked) {
          dependencies.push(...surfaceNodes(outcome.declaration));
        }
      }
    }

    for (const escape of escapesOf(declaration, phase)) {
      if (escape.kind !== "consumption") continue;
      dependencies.push(...colorNodesIn(consumedBy(escape.site, declaration)));
    }

    // Awaiting, discarding and returning a promise each read a color the same
    // way a call does; only the channel the throw arrives on is different.
    for (const site of rejectionSites(declaration, phase)) {
      dependencies.push(...rejectionNodes(site.rejection));
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
    return implicitSupers(body).some((target) => {
      if (target.kind === "carried") return carriedReason(target) !== undefined;
      if (target.kind !== "function") return true;
      return (
        flooredCallee(target, throwingOf) !== undefined ||
        conditions.valueOf(target.declaration).length > 0
      );
    });
  }

  function conditionedTargetsIn(
    body: Bodied,
    phase: Phase,
  ): { site: Transfer; target: ConditionedTarget }[] {
    const found: { site: Transfer; target: ConditionedTarget }[] = [];
    for (const { site, target } of targetsIn(body, phase)) {
      if (target.kind === "function" || target.kind === "carried") {
        found.push({ site, target });
      }
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
        const consumed = consumedReason(
          consumedBy(escape.site, body),
          throwingOf,
        );
        if (consumed !== undefined) {
          found.push({
            kind: "consumption",
            node: escape.site.node,
            reason: consumed.reason,
            staleFile: consumed.staleFile,
            source: consumed.source,
          });
        }
        continue;
      }
      // Both are read off `rejectionSites`, alongside the returns the walk has
      // no single node for.
      if (escape.kind === "await" || escape.kind === "float") continue;
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

    found.push(...rejectionEscapes(body, phase, throwingOf));

    // One site, one diagnostic. A promise-returning callee with no carrier
    // floors on both channels — it might sync-throw and it might reject — and
    // saying so twice at one span offers two conflicting bridges. Bridging the
    // call is the first edit either way, and the float reappears once that
    // bridge is in place and turns out to neutralize only the sync half.
    const sync = new Set(
      found.flatMap((escape) =>
        escape.kind === "callee" ? [escape.node as ts.Node] : [],
      ),
    );
    return found.filter(
      (escape) => escape.kind !== "float" || !sync.has(escape.node),
    );
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
        found.push({
          kind: "callee",
          node: site,
          reason: target.reason,
          staleFile: target.staleFile,
          source: target.source,
        });
      }
      return;
    }

    // A carrier's `async` flag stands in for the modifier declaration emit
    // erased, so the carve-out applies to a carried callee exactly as it does
    // to a visible one — and that flag is the only thing that can license the
    // terminal `.catch(h)` bridge across a `.d.ts` boundary.
    if (target.kind === "carried") {
      if (target.color === "throwing") {
        if (!target.async && !awaitedDirectly(site)) {
          found.push({
            kind: "callee",
            node: site,
            reason: "carried-throwing",
            source: target.source,
          });
        }
        return;
      }
    } else {
      const floored = flooredCallee(target, throwingOf);
      if (floored !== undefined) {
        // The sync channel, and only it. A visibly-`async` callee cannot
        // sync-throw, so what it can do is read at the `await`, the chain or
        // the discard instead; and where the call *is* the awaited expression,
        // the `await` is already the one site for both channels.
        if (!isVisiblyAsync(target.declaration) && !awaitedDirectly(site)) {
          found.push({
            kind: "callee",
            node: site,
            reason: floored,
            constructorless: ts.isClassLike(target.declaration),
          });
        }
        return;
      }
    }

    const calleeSource = target.kind === "carried" ? target.source : undefined;
    for (const { condition, outcome } of dischargesAt(
      site,
      conditionsOfTarget(target, settledConditions),
      body,
    )) {
      const escape = undischarged(
        site,
        condition,
        outcome,
        calleeSource,
        throwingOf,
      );
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
        reason: reason.reason,
        staleFile: reason.staleFile,
        source: reason.source,
      });
      return;
    }
  }

  function hiddenReason(
    target: DeclaredTarget,
    throwingOf: (callee: ColorNode) => boolean,
  ):
    | {
        reason: ThrowingReason;
        staleFile?: string | undefined;
        source?: FloorSource | undefined;
      }
    | undefined {
    if (target.kind === "floor") {
      return {
        reason: target.reason,
        staleFile: target.staleFile,
        source: target.source,
      };
    }

    if (target.kind === "carried") {
      const reason = carriedReason(target);
      return reason === undefined
        ? undefined
        : { reason, source: target.source };
    }

    const floored = flooredCallee(target, throwingOf);
    if (floored !== undefined) return { reason: floored };

    // The site reaches this body through a type rather than handing it over,
    // so a condition on it has no argument here that could discharge one.
    return conditions.valueOf(target.declaration).length > 0
      ? { reason: "conditioned" }
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
    calleeSource: FloorSource | undefined,
    throwingOf: (callee: ColorNode) => boolean,
  ): BodyEscape | undefined {
    const floored = (
      reason: UndischargedReason,
      staleFile?: string | undefined,
      source?: FloorSource | undefined,
    ): BodyEscape => ({
      kind: "argument-floored",
      node: site,
      condition,
      reason,
      staleFile,
      source,
    });

    if (outcome.kind === "propagate") return undefined;
    if (outcome.kind === "present") {
      return {
        kind: "argument-present",
        node: site,
        condition,
        reason: outcome.reason,
        source: calleeSource,
      };
    }
    if (outcome.kind === "floor") {
      return floored(outcome.reason, outcome.staleFile, outcome.source);
    }

    // An argument the carrier colors is answered by what it says.
    if (outcome.kind === "carried") {
      const reason = carriedReason(outcome);
      return reason === undefined
        ? undefined
        : floored(reason, undefined, outcome.source);
    }

    if (!outcome.marked) {
      if (policy === "declare") return floored("unmarked");
      if (surfaceThrows(outcome.declaration, throwingOf)) {
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
      : consumedFrom(declarationTarget(member, resolution), facet);
  }

  /**
   * One facet of a target, as something consuming it can enter. A callee
   * reached through a parameter needs no facet of its own: the condition the
   * path carries demands the argument be non-throwing, and non-throwing is one
   * color over the whole surface — consuming what it hands back included — so
   * the obligation is already the caller's and repeating it here would floor a
   * question that has an answer.
   */
  function consumedFrom(target: Target, facet: Facet): Consumed {
    if (target.kind === "condition") return CONSUMED_CLEAN;
    if (target.kind === "floor") {
      return floorConsumed(target.reason, target.staleFile, target.source);
    }
    // One color, full surface: a carrier calling the producer non-throwing is
    // saying consuming what it hands back is clean too.
    if (target.kind === "carried") {
      const reason = carriedReason(target);
      return reason === undefined
        ? CONSUMED_CLEAN
        : floorConsumed(reason, undefined, target.source);
    }
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
  ):
    | {
        reason: ConsumptionReason;
        staleFile?: string | undefined;
        source?: FloorSource | undefined;
      }
    | undefined {
    for (const part of consumed) {
      if (part.kind === "floor") {
        return {
          reason: part.reason,
          staleFile: part.staleFile,
          source: part.source,
        };
      }
    }
    return consumed.some(
      (part) => part.kind === "color" && throwingOf(part.node),
    )
      ? { reason: "inferred" }
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
    if (origin === undefined) {
      return floorRejection(untracedRejection(expression), "promise");
    }
    // The fold is syntactic. A chain reached through a binding is a stored
    // partial chain, and folding it would be claiming the handlers written
    // somewhere else are the ones this value carries.
    if (origin !== expression && chainAt(origin, checker) !== undefined) {
      return floorRejection("untraced", "promise");
    }

    return joinRejections(
      targetsOf(origin, body).map((target) => rejectedFrom(target, "producer")),
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

    const resolved = resolveValue(argument, body, resolution);
    if (resolved.kind === "mutable") {
      return floorRejection("mutable-binding", "handler");
    }
    if (resolved.kind === "unknown") {
      return floorRejection("unresolvable", "handler");
    }
    return joinRejections(
      resolved.targets.map((target) => rejectedFrom(target, "handler")),
    );
  }

  /**
   * A target as something whose promise can reject, named the way a message
   * has to name it. A parameter means different things in the two positions:
   * the *producer* is a callee, so the condition its path carries covers the
   * promise it hands back along with the rest of its surface, while a *handler*
   * is reached through no transfer the walk records and so carries no condition
   * for anyone to discharge.
   */
  function rejectedFrom(
    target: Target,
    subject: "producer" | "handler",
  ): Rejection {
    if (target.kind === "condition") {
      return subject === "producer"
        ? REJECTION_CLEAN
        : floorRejection("conditioned-handler", "handler");
    }
    if (target.kind === "floor") {
      return floorRejection(
        target.reason,
        subject,
        target.staleFile,
        target.source,
      );
    }
    if (target.kind === "carried") {
      const reason = carriedReason(target);
      return reason === undefined
        ? REJECTION_CLEAN
        : floorRejection(reason, subject, undefined, target.source);
    }
    if (target.marked) return REJECTION_CLEAN;
    if (policy === "declare") return floorRejection("unmarked", subject);
    return { kind: "color", node: nodeFor(target.declaration, "call"), subject };
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
  ): Rejects | undefined {
    switch (rejection.kind) {
      case "clean":
        return undefined;
      case "floor":
        return {
          reason: rejection.reason,
          subject: rejection.subject,
          staleFile: rejection.staleFile,
          source: rejection.source,
        };
      case "color":
        return throwingOf(rejection.node)
          ? { reason: "inferred", subject: rejection.subject }
          : undefined;
      case "join": {
        // A floor outranks a read body: it is the one the reader can act on
        // with something other than a bridge.
        const found = rejection.parts.flatMap((part) => {
          const rejects = rejectionReason(part, throwingOf);
          return rejects === undefined ? [] : [rejects];
        });
        return found.find(({ reason }) => reason !== "inferred") ?? found[0];
      }
      case "discharged":
        return rejectionReason(rejection.source, throwingOf) === undefined
          ? undefined
          : rejectionReason(rejection.handler, throwingOf);
    }
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

  /**
   * Every place this body consumes a promise's own channel. The one walk both
   * readers go through: the fixpoint orders the colors these turn on, and the
   * findings are read off the same list, so a dependency the fixpoint never
   * ordered cannot arise from the two disagreeing about what the body does.
   *
   * A `return` is here rather than in the walk because it is not one site: an
   * expression-bodied arrow has no `return` to find.
   */
  function rejectionSites(
    body: Bodied,
    phase: Phase,
  ): readonly RejectionSite[] {
    const sites: RejectionSite[] = [];

    for (const escape of escapesOf(body, phase)) {
      if (escape.kind === "await") {
        sites.push({
          kind: "await",
          node: escape.node,
          rejection: rejectionOf(escape.node.expression, body),
          fake: false,
        });
      } else if (escape.kind === "float") {
        sites.push({
          kind: "float",
          node: escape.node,
          rejection: rejectionOf(escape.node, body),
          fake: escape.bridged && cannotFire(escape.node, body),
        });
      }
    }

    // An uncaught `throw` in an `async` body is a rejection of its own promise,
    // which the walk already reports; what a `return` adds is the rejection of
    // a promise the body hands on rather than one it makes.
    if (phase !== "eager" && !isGenerator(body)) {
      for (const expression of returnedExpressions(body)) {
        sites.push({
          kind: "return",
          node: expression,
          rejection: rejectionOf(expression, body),
          fake: false,
        });
      }
    }

    return sites;
  }

  function rejectionEscapes(
    body: Bodied,
    phase: Phase,
    throwingOf: (callee: ColorNode) => boolean,
  ): readonly BodyEscape[] {
    const found: BodyEscape[] = [];

    for (const site of rejectionSites(body, phase)) {
      const rejects = rejectionReason(site.rejection, throwingOf);
      if (rejects === undefined) continue;
      found.push({
        kind:
          site.kind === "await"
            ? "rejected-await"
            : site.kind === "float"
              ? "float"
              : "rejected-return",
        node: site.node,
        rejects,
        fake: site.fake,
      });
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
          (target.kind === "function" && isVisiblyAsync(target.declaration)) ||
          (target.kind === "carried" && target.async),
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
      return subsumedByThrow([
        ...bodyEscapes(body, "all", throwingOf),
        ...returnedIterators(body, throwingOf),
      ]);
    },
    conditionsIn: settledConditions,
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
      const consumed = consumedReason(producedBy(expression, body), throwingOf);
      if (consumed !== undefined) {
        found.push({
          kind: "returned-iterator",
          node: expression,
          reason: consumed.reason,
          staleFile: consumed.staleFile,
          source: consumed.source,
        });
      }
    }
    return found;
  }
}

/**
 * One `throw`, one report. What builds the value a `throw` hands out cannot be
 * answered for on its own: bridging `new MyError(…)` leaves the `throw` it feeds
 * exactly where it was, and removing the `throw` takes its operand with it. So
 * the escapes inside one are subsumed by the `uncaughtThrow` that already names
 * the problem, rather than reported beside it with an out that is not one.
 *
 * Filtered here rather than in the walk, which inference reads: a body's color
 * is what it does, and dropping an edge to tidy a message would be answering a
 * different question in the two places.
 */
function subsumedByThrow(
  escapes: readonly BodyEscape[],
): readonly BodyEscape[] {
  const thrown = escapes.flatMap((escape) =>
    escape.kind === "throw" ? [escape.node.expression] : [],
  );
  if (thrown.length === 0) return escapes;

  return escapes.filter(
    (escape) =>
      escape.kind === "throw" ||
      !thrown.some((operand) => contains(operand, escape.node)),
  );
}

function contains(ancestor: ts.Node, node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current !== undefined;
    current = current.parent
  ) {
    if (current === ancestor) return true;
  }
  return false;
}

function floorConsumed(
  reason: ConsumptionReason,
  staleFile?: string | undefined,
  source?: FloorSource | undefined,
): Consumed {
  return { kind: "floor", reason, staleFile, source };
}

function floorRejection(
  reason: RejectionReason,
  subject: RejectionSubject,
  staleFile?: string | undefined,
  source?: FloorSource | undefined,
): Rejection {
  return { kind: "floor", reason, subject, staleFile, source };
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

function sameConditions(a: readonly Condition[], b: readonly Condition[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(b.map(conditionKey));
  return a.every((condition) => keys.has(conditionKey(condition)));
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

import ts from "typescript";
import type { ThrowingReason, UndischargedReason } from "./colors.js";
import { pathKey, type Condition } from "./conditions.js";
import { dischargeAt, type Outcome } from "./discharge.js";
import { baseClassExpression, type Bodied } from "./declarations.js";
import { unbridgedEscapes, type Transfer } from "./escapes.js";
import { createFixpoint } from "./infer.js";
import { colorPolicy } from "./policy.js";
import { calleeTargets, constructedTarget, type Target } from "./targets.js";

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

export function createColorResolver(checker: ts.TypeChecker): ColorResolver {
  const policy = colorPolicy();

  const escapesOf = memoize((body: Bodied) => unbridgedEscapes(body));

  const targetsAt = new Map<Transfer, readonly Target[]>();
  const outcomesAt = new Map<Transfer, Map<string, readonly Outcome[]>>();

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
  function targetsIn(body: Bodied): readonly SiteTarget[] {
    return escapesOf(body)
      .filter((escape) => !ts.isThrowStatement(escape))
      .flatMap((site) => targetsOf(site, body).map((target) => ({ site, target })));
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
    return base === undefined
      ? undefined
      : constructedTarget(base, checker);
  }

  /**
   * The condition set, resolved over the same graph as the color. It reads no
   * color, which is what keeps the two dimensions from chasing each other: a
   * path is a syntactic fact about which parameters a body enters, and only
   * whether the argument at one *can throw* needs a color.
   */
  const conditions = createFixpoint<readonly Condition[]>({
    bottom: [],
    unresolved: [],
    dependenciesOf: (body) => bodiedTargetsIn(body).map(({ target }) => target.declaration),
    recompute: (body, conditionsOf) => {
      const derived = new Map<string, Condition>();
      const add = (path: Condition["path"], entry: Transfer): void => {
        const key = pathKey(path);
        if (!derived.has(key)) derived.set(key, { path, owner: body, entry });
      };

      for (const { site, target } of targetsIn(body)) {
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
   * Whether a body can throw. Pinned nodes cut this graph and do not
   * participate — marked seeds and floors alike — so what is walked is the
   * reachable unmarked subgraph, plus the arguments a condition makes it
   * depend on.
   */
  const throwing = createFixpoint<boolean>({
    bottom: false,
    unresolved: true,
    dependenciesOf: (body) => {
      const dependencies: Bodied[] = [];

      const followed = implicitSuper(body);
      if (followed?.kind === "function" && !followed.marked) {
        dependencies.push(followed.declaration);
      }

      for (const { site, target } of bodiedTargetsIn(body)) {
        if (!target.marked) dependencies.push(target.declaration);
        for (const { outcome } of dischargesAt(
          site,
          target,
          body,
          settledConditions,
        )) {
          if (outcome.kind === "function" && !outcome.marked) {
            dependencies.push(outcome.declaration);
          }
        }
      }

      return dependencies;
    },
    recompute: (body, throwingOf) =>
      bodyEscapes(body, throwingOf).length > 0 ||
      implicitSuperThrows(body, throwingOf),
    settled: (a, b) => a === b,
  });

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
    throwingOf: (callee: Bodied) => boolean,
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
  ): { site: Transfer; target: BodiedTarget }[] {
    const found: { site: Transfer; target: BodiedTarget }[] = [];
    for (const { site, target } of targetsIn(body)) {
      if (target.kind === "function") found.push({ site, target });
    }
    return found;
  }

  function bodyEscapes(
    body: Bodied,
    throwingOf: (callee: Bodied) => boolean,
  ): readonly BodyEscape[] {
    const found: BodyEscape[] = [];

    for (const escape of escapesOf(body)) {
      if (ts.isThrowStatement(escape)) {
        found.push({ kind: "throw", node: escape });
        continue;
      }
      for (const target of targetsOf(escape, body)) {
        collect(found, escape, target, body, throwingOf);
      }
    }

    return found;
  }

  function collect(
    found: BodyEscape[],
    site: Transfer,
    target: Target,
    body: Bodied,
    throwingOf: (callee: Bodied) => boolean,
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
    throwingOf: (callee: Bodied) => boolean,
  ): ThrowingReason | undefined {
    if (target.marked) return undefined;
    if (policy === "declare") return "unmarked";
    return throwingOf(target.declaration) ? "inferred" : undefined;
  }

  function undischarged(
    site: Transfer,
    condition: Condition,
    outcome: Outcome,
    throwingOf: (callee: Bodied) => boolean,
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
      if (throwingOf(outcome.declaration)) {
        return { kind: "argument-throwing", node: site, condition };
      }
    }

    // An argument non-throwing only given conditions of its own needs its own
    // arguments to discharge them, and this site has none to offer.
    return conditions.valueOf(outcome.declaration).length > 0
      ? floored("conditioned")
      : undefined;
  }

  return {
    escapesIn(body) {
      return bodyEscapes(body, (callee) => throwing.valueOf(callee));
    },
  };
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

import {
  algorithmSteps,
  argumentsOf,
  callSites,
  parseClauses,
  splitArguments,
  stripTags,
  THROW_SITE,
  type Clause,
  type Step,
} from "./parse.js";
import type { Absence } from "@no-throw/core/baseline";

import { liftOperand, OperandTrace, type Operand } from "./operands.js";

/**
 * One reason a builtin can throw, resolved to the value it is about. The
 * generator hands over the *whole* set and signs hazards, not verdicts: one
 * witness per operation can report the cause the declared type discharges and
 * hide the one it does not, which is unsound rather than merely imprecise.
 */
export interface Hazard {
  readonly error: string;
  /** The prose of the triggering condition — what the classifier keys on. */
  readonly condition: string;
  /** The operation the throw is written in. `EXPLICIT` is the builtin itself. */
  readonly rootOp: string;
  readonly via: readonly string[];
  readonly operand: Operand;
  /**
   * Names the builtin's own steps established hold a value before this hazard
   * can be reached, by returning early where they do not. Every hazard
   * `new Map()` has is one of these: ECMA-262 returns at step 4 when `iterable`
   * is absent, and steps 5 to 7 hold the rest.
   *
   * The builtin's own namespace, so a name here is a parameter of the member
   * itself and the classifier can turn it into a condition on that position.
   * Nothing lifted from a callee carries one — a fact about the callee's own
   * locals is not a fact any call site could discharge.
   */
  readonly given: readonly Guard[];
}

/**
 * One name an early return has ruled out, and *which* nothing it ruled out.
 * The two guards are not interchangeable and flattening them into one
 * requirement overclaims: `Number.prototype.toPrecision` returns on `undefined`
 * alone, so an entry saying `null` is fine there says more than ECMA-262 does.
 */
export interface Guard {
  readonly name: string;
  readonly requires: Absence;
}

export interface SpecBuiltin {
  readonly name: string;
  readonly title: string;
  readonly params: readonly string[];
  readonly hasAlgorithm: boolean;
  readonly aliasOf: string | undefined;
  readonly hazards: readonly Hazard[];
  readonly unresolvedCallees: readonly string[];
}

export interface SpecAccessor {
  readonly get: string | undefined;
  readonly set: string | undefined;
}

export interface SpecCorpus {
  readonly builtins: ReadonlyMap<string, SpecBuiltin>;
  /** Property spec name (`RegExp.prototype.flags`) → its accessor functions. */
  readonly accessors: ReadonlyMap<string, SpecAccessor>;
  readonly stats: {
    readonly clauses: number;
    readonly operations: number;
    readonly throwingOperations: number;
    readonly rootCauses: number;
    readonly builtins: number;
    readonly hazards: number;
    readonly aliasesResolved: number;
    readonly unresolvedCallees: readonly string[];
  };
}

const OPERATION_TYPES = new Set([
  "abstract operation",
  "numeric method",
  "host-defined abstract operation",
  "implementation-defined abstract operation",
  "concrete method",
  "internal method",
]);

/**
 * One `?`-marked call an operation makes, with what the steps enclosing it have
 * already settled about the values it passes.
 */
interface AbruptCall {
  readonly name: string;
  readonly args: readonly string[];
  /** Names an enclosing guard has established are Objects. */
  readonly objects: ReadonlySet<string>;
}

interface Operation {
  readonly name: string;
  readonly params: readonly string[];
  readonly trace: OperandTrace;
  readonly ownThrows: readonly { condition: string; error: string }[];
  readonly calls: readonly AbruptCall[];
}

function paramsOf(title: string): readonly string[] {
  return (/\(([^)]*)\)/.exec(title)?.[1] ?? "")
    .split(",")
    .map((param) => param.replace(/[[\]]/g, "").replace(/^\.{3}/, "").trim())
    .filter((param) => param !== "");
}

function abruptCalls(
  step: Step,
  reassigned: ReadonlySet<string>,
): readonly AbruptCall[] {
  const objects = objectsEstablishedBy(step.guards, reassigned);
  return callSites(step.html)
    .filter((site) => site.mark === "?")
    .map((site) => ({
      name: site.name,
      args: splitArguments(argumentsOf(step.text, site.name)),
      objects,
    }));
}

/**
 * ECMA-262 writes the object half of a coercion as a guard rather than as a
 * type — `ToPrimitive`'s `If input is an Object, then` is the one every
 * coercion goes through — and the steps under it are entered for nothing else.
 * Lifting a cause out of there without the guard is what makes `ToString` of a
 * declared `string` look like it can reach `ToObject`, on a couple of hundred
 * members.
 *
 * Negation is not matched, deliberately: `If x is not an Object` establishes
 * this for its `Else` branch and the `Else` is a sibling step, so the fact is
 * simply not read there.
 */
const ESTABLISHES_OBJECT = /\bIf (\w+) is an Object\b/g;

/**
 * `Set x to …`, which is how ECMA-262 spells rebinding. A guard is matched to a
 * call by *name*, so a name the algorithm ever rebinds cannot carry a fact from
 * the guard down to the call — the value there may no longer be the one that
 * was tested. Any rebinding anywhere in the operation disqualifies the name,
 * rather than only the ones between the two steps: dropping a cause is the
 * unsafe direction, and step order is not a control-flow graph.
 */
const REBINDS = /^Set (\w+) to\b/;

function reassignedNames(steps: readonly Step[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const step of steps) {
    const name = REBINDS.exec(step.text)?.[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

function objectsEstablishedBy(
  guards: readonly string[],
  reassigned: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const guard of guards) {
    for (const match of guard.matchAll(ESTABLISHES_OBJECT)) {
      const name = match[1];
      if (name !== undefined && !reassigned.has(name)) names.add(name);
    }
  }
  return names;
}

/**
 * An early return on an absent argument: `If iterable is either undefined or
 * null, return map`. Every step that runs after one of these runs only because
 * the name held a value, which is the fact `new Map()` needs and the enclosing
 * guards cannot carry — the step is a *sibling* of what it protects, not its
 * parent.
 *
 * The return has to be unconditional in the same step. `If x is undefined,
 * then` opening a sub-list establishes the fact for that list and not for what
 * follows it, and that shape is the enclosing-guard reading's business.
 *
 * The spelling is captured rather than flattened away, because it is the whole
 * content of the condition the entry ships: the first alternative admits `null`
 * at the call site and the second does not. ECMA-262's third spelling, `If x is
 * null, return`, is deliberately absent — a member behind one is simply not
 * read as guarded, so it ships throwing. Recognizing it would need a third
 * condition form to state truthfully, and no builtin needs one today; matching
 * it under either existing form would claim the guard covers an omitted
 * argument, which is the direction that lies.
 */
const RETURNS_IF_ABSENT =
  /^If (\w+) is (either undefined or null|undefined), return\b/;

/**
 * Which nothing `RETURNS_IF_ABSENT` matched, as the condition grammar spells
 * it. Only the exact prose that returns on `null` earns the form admitting it,
 * so anything else falls to the narrow one — which is over-strict at the call
 * site rather than a lie about it.
 */
function absenceOf(spelling: string): Absence {
  return spelling === "either undefined or null" ? "nullish" : "undefined";
}

/**
 * The guards an early return has established by the time this step runs. A fact
 * holds for the steps *after* the return in the same list, and for everything
 * nested under them: those are exactly the steps the return can skip.
 */
function establishedBefore(
  step: Step,
  returns: readonly (Guard & { path: readonly number[] })[],
): readonly Guard[] {
  return returns
    .filter(({ path }) => {
      const depth = path.length - 1;
      return (
        step.path.length > depth &&
        path.slice(0, depth).every((at, index) => step.path[index] === at) &&
        (step.path[depth] ?? -1) > (path[depth] ?? 0)
      );
    })
    .map(({ name, requires }) => ({ name, requires }));
}

/** A throw condition that fires only on something that is not an Object. */
const NEEDS_A_NON_OBJECT =
  /is either undefined or null|RequireObjectCoercible|is not an Object\b/;

/**
 * Whether a guard the call sits under makes this cause unreachable. One fact
 * and one shape only, about the whole value: a guard saying `input` is an
 * Object rules out `input` being nullish or not an Object, and says nothing at
 * all about a property of it or about any other value the callee touches.
 */
function ruledOutByGuard(call: AbruptCall, cause: Hazard): boolean {
  if (call.objects.size === 0) return false;
  const { operand } = cause;
  if (operand.root !== "param" || operand.segments.length > 0) return false;
  const passed = call.args[operand.index]?.trim();
  return (
    passed !== undefined &&
    call.objects.has(passed) &&
    NEEDS_A_NON_OBJECT.test(cause.condition)
  );
}

export function extractSpec(html: string): SpecCorpus {
  const clauses = parseClauses(html);

  const operations = new Map<string, Operation>();
  const internalMethods = new Map<string, Operation>();

  for (const clause of clauses) {
    if (clause.type === undefined || !OPERATION_TYPES.has(clause.type)) continue;
    const name = clause.aoid ?? clause.title.split(/[\s(]/)[0] ?? "";
    if (name === "") continue;
    const operation = buildOperation(name, clause);

    if (clause.type === "internal method") {
      // `[[Get]]` is dispatched dynamically: ordinary, exotic and Proxy
      // variants share the name, so all their throw sites apply.
      const key = /\[\[(\w+)\]\]/.exec(clause.title)?.[1];
      if (key !== undefined) {
        const merged = internalMethods.get(`[[${key}]]`);
        internalMethods.set(
          `[[${key}]]`,
          merged === undefined ? { ...operation, name: `[[${key}]]` } : merge(merged, operation),
        );
      }
    }
    if (!operations.has(name)) operations.set(name, operation);
  }
  for (const [name, operation] of internalMethods) operations.set(name, operation);

  const causes = resolveCauses(operations);

  // A builtin's own steps, plus every cause of every `?`-marked call it makes.
  const builtins = new Map<string, SpecBuiltin>();
  const clauseOf = new Map<string, Clause>();
  for (const clause of clauses) {
    if (clause.type !== "built-in function") continue;
    const title = clause.title;
    // Everything before the parameter list. Bracket groups are *not* stripped:
    // `Array.prototype [ %Symbol.iterator% ] ( )` names a symbol-keyed member,
    // and only the parameter list's optional-argument brackets are noise.
    const name = title.split("(")[0]?.trim() ?? "";
    if (name === "" || builtins.has(name)) continue;
    clauseOf.set(name, clause);

    const steps = algorithmSteps(clause.ownHtml);
    const params = paramsOf(title);
    const trace = new OperandTrace(
      params,
      steps.map((step) => step.text),
    );
    const hazards: Hazard[] = [];
    const unresolved: string[] = [];
    const reassigned = reassignedNames(steps);

    // A name the algorithm rebinds cannot carry a fact forward, for the reason
    // an enclosing guard's cannot: the value at the later step may not be the
    // one that was tested.
    const earlyReturns = steps.flatMap((step) => {
      const match = RETURNS_IF_ABSENT.exec(step.text);
      const name = match?.[1];
      if (name === undefined || reassigned.has(name)) return [];
      return [{ name, requires: absenceOf(match?.[2] ?? ""), path: step.path }];
    });

    for (const step of steps) {
      const given = establishedBefore(step, earlyReturns);
      const explicit = THROW_SITE.exec(step.html);
      if (explicit !== null) {
        hazards.push({
          error: explicit[1] ?? "TypeError",
          condition: step.context,
          rootOp: "EXPLICIT",
          via: [],
          operand: trace.subjectOf(step.context),
          given,
        });
      }
      for (const call of abruptCalls(step, reassigned)) {
        const calleeCauses = causes.get(call.name);
        if (calleeCauses === undefined) {
          if (!operations.has(call.name)) unresolved.push(call.name);
          continue;
        }
        for (const cause of calleeCauses.values()) {
          if (ruledOutByGuard(call, cause)) continue;
          hazards.push({
            error: cause.error,
            condition: cause.condition,
            rootOp: cause.rootOp,
            via: [call.name, ...cause.via],
            operand: liftOperand(cause.operand, call.args, trace),
            given,
          });
        }
      }
    }

    builtins.set(name, {
      name,
      title,
      params,
      hasAlgorithm: /<emu-alg>/.test(clause.ownHtml),
      aliasOf: undefined,
      hazards: dedupeHazards(hazards),
      unresolvedCallees: [...new Set(unresolved)],
    });
  }

  const aliasesResolved = resolveAliases(clauseOf, builtins);
  const accessors = collectAccessors(builtins);

  const unresolvedCallees = new Set<string>();
  let hazardCount = 0;
  for (const builtin of builtins.values()) {
    hazardCount += builtin.hazards.length;
    for (const callee of builtin.unresolvedCallees) unresolvedCallees.add(callee);
  }

  return {
    builtins,
    accessors,
    stats: {
      clauses: clauses.length,
      operations: operations.size,
      throwingOperations: causes.size,
      rootCauses: [...causes.values()].reduce((sum, set) => sum + set.size, 0),
      builtins: builtins.size,
      hazards: hazardCount,
      aliasesResolved,
      unresolvedCallees: [...unresolvedCallees],
    },
  };
}

function buildOperation(name: string, clause: Clause): Operation {
  const steps = algorithmSteps(clause.ownHtml);
  const params = paramsOf(clause.title);
  const ownThrows: { condition: string; error: string }[] = [];
  const calls: AbruptCall[] = [];
  const reassigned = reassignedNames(steps);

  for (const step of steps) {
    const explicit = THROW_SITE.exec(step.html);
    if (explicit !== null) {
      ownThrows.push({ condition: step.context, error: explicit[1] ?? "TypeError" });
    }
    calls.push(...abruptCalls(step, reassigned));
  }
  // Prose-only operations state their throw in a paragraph, not an algorithm.
  if (
    ownThrows.length === 0 &&
    THROW_SITE.test(clause.ownHtml) &&
    !/<emu-alg>/.test(clause.ownHtml)
  ) {
    ownThrows.push({ condition: stripTags(clause.ownHtml).slice(0, 240), error: "prose" });
  }

  return {
    name,
    params,
    trace: new OperandTrace(
      params,
      steps.map((step) => step.text),
    ),
    ownThrows,
    calls,
  };
}

function merge(left: Operation, right: Operation): Operation {
  return {
    ...left,
    ownThrows: [...left.ownThrows, ...right.ownThrows],
    calls: [...left.calls, ...right.calls],
  };
}

/**
 * Least fixpoint over the `?`-marked call edges. Each operation carries the
 * whole set of root causes it can reach, each still pointing at the value it
 * is about in *this* operation's namespace.
 */
function resolveCauses(
  operations: ReadonlyMap<string, Operation>,
): ReadonlyMap<string, Map<string, Hazard>> {
  const causes = new Map<string, Map<string, Hazard>>();

  for (const [name, operation] of operations) {
    if (operation.ownThrows.length === 0) continue;
    const own = new Map<string, Hazard>();
    for (const thrown of operation.ownThrows) {
      if (own.has(thrown.condition)) continue;
      own.set(thrown.condition, {
        error: thrown.error,
        condition: thrown.condition,
        rootOp: name,
        via: [],
        operand: operation.trace.subjectOf(thrown.condition),
        // An operation's own early returns are about its own locals, and a
        // caller's argument list is where those names stop meaning anything.
        given: [],
      });
    }
    causes.set(name, own);
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, operation] of operations) {
      const mine = causes.get(name) ?? new Map<string, Hazard>();
      const before = mine.size;
      for (const call of operation.calls) {
        for (const cause of (causes.get(call.name) ?? new Map()).values()) {
          if (mine.has(cause.condition)) continue;
          if (ruledOutByGuard(call, cause)) continue;
          mine.set(cause.condition, {
            error: cause.error,
            condition: cause.condition,
            rootOp: cause.rootOp,
            via: [call.name, ...cause.via],
            operand: liftOperand(cause.operand, call.args, operation.trace),
            given: [],
          });
        }
      }
      if (mine.size !== before) {
        causes.set(name, mine);
        changed = true;
      }
    }
  }

  return causes;
}

/**
 * `%TypedArray%.prototype.toString` has no algorithm: its value *is*
 * `%Array.prototype.toString%`. Such a clause looks hazard-free while the
 * aliased function's hazards apply in full — only the hostile fuzzer surfaced
 * it, on eleven typed-array members.
 */
function resolveAliases(
  clauseOf: ReadonlyMap<string, Clause>,
  builtins: Map<string, SpecBuiltin>,
): number {
  let resolved = 0;
  for (const [name, builtin] of builtins) {
    if (builtin.hasAlgorithm || builtin.hazards.length > 0) continue;
    const clause = clauseOf.get(name);
    const alias = /initial value of the [\s\S]{0,400}?\bis %([\w.]+)%/.exec(
      clause?.ownHtml ?? "",
    )?.[1];
    // The prose spells the intrinsic `%TypedArray.prototype.values%` while the
    // clause it names is `%TypedArray%.prototype.values`.
    const target =
      alias === undefined
        ? undefined
        : (builtins.get(alias) ??
          builtins.get(alias.replace(/^TypedArray\./, "%TypedArray%.")));
    if (target === undefined || target.hazards.length === 0) continue;
    builtins.set(name, {
      ...builtin,
      aliasOf: target.name,
      hazards: target.hazards.map((hazard) => ({
        ...hazard,
        via: [`alias→${target.name}`, ...hazard.via],
        // The names are the *aliased* clause's parameters, and this clause
        // writes its own parameter list. A name that happens to appear in both
        // could name a different position, so the fact is dropped rather than
        // carried across.
        given: [],
      })),
    });
    resolved++;
  }
  return resolved;
}

/** Clauses titled `get X` / `set X` are ECMA-262's own accessor oracle. */
function collectAccessors(
  builtins: ReadonlyMap<string, SpecBuiltin>,
): ReadonlyMap<string, SpecAccessor> {
  const accessors = new Map<string, SpecAccessor>();
  for (const name of builtins.keys()) {
    const match = /^(get|set) (.+)$/.exec(name);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const property = match[2].trim();
    const current = accessors.get(property) ?? { get: undefined, set: undefined };
    accessors.set(
      property,
      match[1] === "get" ? { ...current, get: name } : { ...current, set: name },
    );
  }
  return accessors;
}

function dedupeHazards(hazards: readonly Hazard[]): readonly Hazard[] {
  const seen = new Map<string, Hazard>();
  for (const hazard of hazards) {
    const key = `${hazard.rootOp} ${hazard.condition} ${hazard.operand.root}${hazard.operand.index}${hazard.operand.segments.map((segment) => segment.kind + ("name" in segment ? segment.name : "")).join()}`;
    const known = seen.get(key);
    if (known === undefined) {
      seen.set(key, hazard);
      continue;
    }
    // The same cause at two steps is reachable however either one is guarded,
    // so what survives is what both agree on. Keeping the first would let a
    // step behind an early return answer for one that is not. Where both guard
    // a name but spell the nothing differently, what they agree on is the
    // narrower spelling — the cause is skipped only by a call the *both* of
    // them return for.
    const shared = known.given.flatMap((guard) => {
      const other = hazard.given.find(({ name }) => name === guard.name);
      if (other === undefined) return [];
      return other.requires === guard.requires
        ? [guard]
        : [{ ...guard, requires: "undefined" as const }];
    });
    seen.set(key, { ...known, given: shared });
  }
  return [...seen.values()];
}

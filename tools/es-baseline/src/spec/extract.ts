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

interface Operation {
  readonly name: string;
  readonly params: readonly string[];
  readonly steps: readonly Step[];
  readonly trace: OperandTrace;
  readonly ownThrows: readonly { condition: string; error: string }[];
  readonly calls: readonly { name: string; args: readonly string[] }[];
}

function paramsOf(title: string): readonly string[] {
  return (/\(([^)]*)\)/.exec(title)?.[1] ?? "")
    .split(",")
    .map((param) => param.replace(/[[\]]/g, "").replace(/^\.{3}/, "").trim())
    .filter((param) => param !== "");
}

function abruptCalls(
  step: Step,
): readonly { name: string; args: readonly string[] }[] {
  return callSites(step.html)
    .filter((site) => site.mark === "?")
    .map((site) => ({
      name: site.name,
      args: splitArguments(argumentsOf(step.text, site.name)),
    }));
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

    for (const step of steps) {
      const explicit = THROW_SITE.exec(step.html);
      if (explicit !== null) {
        hazards.push({
          error: explicit[1] ?? "TypeError",
          condition: step.context,
          rootOp: "EXPLICIT",
          via: [],
          operand: trace.subjectOf(step.context),
        });
      }
      for (const call of abruptCalls(step)) {
        const calleeCauses = causes.get(call.name);
        if (calleeCauses === undefined) {
          if (!operations.has(call.name)) unresolved.push(call.name);
          continue;
        }
        for (const cause of calleeCauses.values()) {
          hazards.push({
            error: cause.error,
            condition: cause.condition,
            rootOp: cause.rootOp,
            via: [call.name, ...cause.via],
            operand: liftOperand(cause.operand, call.args, trace),
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
  const calls: { name: string; args: readonly string[] }[] = [];

  for (const step of steps) {
    const explicit = THROW_SITE.exec(step.html);
    if (explicit !== null) {
      ownThrows.push({ condition: step.context, error: explicit[1] ?? "TypeError" });
    }
    calls.push(...abruptCalls(step));
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
    steps,
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
          mine.set(cause.condition, {
            error: cause.error,
            condition: cause.condition,
            rootOp: cause.rootOp,
            via: [call.name, ...cause.via],
            operand: liftOperand(cause.operand, call.args, operation.trace),
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
    if (!seen.has(key)) seen.set(key, hazard);
  }
  return [...seen.values()];
}

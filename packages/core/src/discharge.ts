import ts from "typescript";
import type { Absence } from "./baseline/paths.js";
import type {
  AbsenceReason,
  FloorSource,
  UndischargedReason,
} from "./colors.js";
import {
  MAX_CONDITION_DEPTH,
  pathOf,
  skipParens,
  type Condition,
  type ParameterPath,
} from "./conditions.js";
import type { Bodied } from "./declarations.js";
import type { Transfer } from "./escapes.js";
import {
  memberTargets,
  resolveReceiver,
  resolveValue,
  type Resolution,
  type Target,
} from "./targets.js";
import { boundDeclaration, type TypeFacts } from "./type-facts.js";

/**
 * What one of a callee's conditions comes to at one call site. `propagate` is
 * the genuinely new mechanism: the argument is itself reachable from the
 * caller's parameters, so the condition moves up instead of discharging, with
 * the callee's remaining segments appended to the caller's path.
 */
export type Outcome =
  | { readonly kind: "propagate"; readonly path: ParameterPath }
  /** An absence condition's only failure: the position is not empty. */
  | { readonly kind: "present"; readonly reason: AbsenceReason }
  /** The argument resolved to a body, or to a carrier's entry for one. */
  | Extract<Target, { readonly kind: "function" | "carried" }>
  | {
      readonly kind: "floor";
      readonly reason: UndischargedReason;
      /** The file whose hash drifted; only `stale-manifest` carries one. */
      readonly staleFile?: string | undefined;
      /** Absent where the argument is not a standard-library declaration. */
      readonly source?: FloorSource | undefined;
    };

/**
 * Resolve the argument a condition is about, at the call site the condition
 * has to be discharged at. A join, like the callee side: a branch between two
 * arguments has to answer for both.
 */
export function dischargeAt(
  transfer: Transfer,
  condition: Condition,
  caller: Bodied,
  resolution: Resolution,
): readonly Outcome[] {
  const args = argumentsOf(transfer);
  return condition.requires === "entered"
    ? enteredAt(args, condition.path, caller, resolution)
    : absenceAt(
        args,
        condition.path.paramIndex,
        condition.requires,
        resolution.facts,
      );
}

/**
 * An absence condition, which resolves nothing: the question is whether
 * anything arrives at the position, never what.
 */
function absenceAt(
  args: readonly ts.Expression[] | undefined,
  paramIndex: number,
  requires: Absence,
  facts: TypeFacts,
): readonly Outcome[] {
  // A tagged template's arguments are the template's own strings and
  // substitutions, so there is no position there to read — but the question is
  // answered all the same, and in the negative: whatever the tag receives at
  // the position, it receives something.
  if (args === undefined) return [{ kind: "present", reason: "argument-passed" }];

  // A spread ahead of the position makes reading arguments positionally
  // meaningless, so whether anything arrives is a runtime question.
  if (args.some((arg, index) => index <= paramIndex && ts.isSpreadElement(arg))) {
    return [{ kind: "present", reason: "unresolvable" }];
  }

  const argument = args[paramIndex];
  return argument === undefined || namesNothing(argument, requires, facts)
    ? []
    : [{ kind: "present", reason: "argument-passed" }];
}

/** An `entered` condition: which function reaches the position, if one can. */
function enteredAt(
  args: readonly ts.Expression[] | undefined,
  path: ParameterPath,
  caller: Bodied,
  resolution: Resolution,
): readonly Outcome[] {
  const { facts } = resolution;
  const { paramIndex, members } = path;

  // A tagged template's arguments are the template's own strings and
  // substitutions, so there is no position here to read the condition at.
  if (args === undefined) return [{ kind: "floor", reason: "unresolvable" }];

  // A spread ahead of the position makes reading arguments positionally
  // meaningless, and which function lands there is a runtime question.
  if (args.some((arg, index) => index <= paramIndex && ts.isSpreadElement(arg))) {
    return [{ kind: "floor", reason: "unresolvable" }];
  }

  const argument = args[paramIndex];
  if (argument === undefined) {
    return [{ kind: "floor", reason: "missing-argument" }];
  }

  if (members.length === 0) {
    const resolved = resolveValue(argument, caller, resolution);
    if (resolved.kind === "mutable") {
      return [{ kind: "floor", reason: "mutable-binding" }];
    }
    if (resolved.kind === "unknown") {
      return [{ kind: "floor", reason: "unresolvable" }];
    }
    return resolved.targets.map((target) => outcomeOf(target, members));
  }

  // Past depth 0 the argument is an object the path is walked through, not a
  // function entered. The member is answered by the checker's symbol for it —
  // but on the value in hand, since a binding's declared type is a promise a
  // subclass is free to override the named member out from under.
  const argumentPath = pathOf(argument, caller, facts);
  if (argumentPath !== undefined) return [propagate(argumentPath, members)];

  const receiver = resolveReceiver(argument, facts);
  if (receiver.kind === "mutable") {
    return [{ kind: "floor", reason: "mutable-binding" }];
  }
  if (receiver.kind === "unknown") {
    return [{ kind: "floor", reason: "unresolvable" }];
  }
  return receiver.values.flatMap((value) =>
    memberTargets(value, members, resolution).map((target) =>
      outcomeOf(target, members),
    ),
  );
}

/**
 * Whether the argument is written as the nothing this condition asks for.
 * `new Map(undefined)` is as clean as `new Map()`, because the guard ECMA-262
 * states there is `either undefined or null` — and `new Map(null)` is clean for
 * the same reason. The guard behind `Number.prototype.toPrecision` is
 * `If precision is undefined`, which is why `null` is admitted by requirement
 * and not by spelling: `(1).toPrecision(null)` reaches the RangeError.
 *
 * Read off the syntax, and deliberately not off the type. A type here is the
 * checker's *narrowed* one, and narrowing a reassignable binding is unsound
 * across a closure that writes it: `let x: T | undefined = undefined` still
 * reads `undefined` at a call made after something else assigned `x`. There is
 * no absence to observe in that program and the entry's color would be a lie.
 * Two spellings cannot be narrowed into: the `null` keyword, and the global
 * `undefined`, which is the one identifier with no declaration to shadow it.
 */
function namesNothing(
  argument: ts.Expression,
  requires: Absence,
  facts: TypeFacts,
): boolean {
  const written = skipParens(argument);
  if (written.kind === ts.SyntaxKind.NullKeyword) return requires === "nullish";
  if (!ts.isIdentifier(written) || written.text !== "undefined") return false;
  return boundDeclaration(written, facts) === undefined;
}

/** The arguments a transfer passes positionally, where it passes any. */
function argumentsOf(
  transfer: Transfer,
): readonly ts.Expression[] | undefined {
  if (ts.isTaggedTemplateExpression(transfer)) return undefined;
  return transfer.arguments ?? [];
}

function outcomeOf(target: Target, members: readonly string[]): Outcome {
  return target.kind === "condition"
    ? propagate(target.path, members)
    : target;
}

function propagate(base: ParameterPath, members: readonly string[]): Outcome {
  const combined = [...base.members, ...members];
  if (combined.length > MAX_CONDITION_DEPTH) {
    return { kind: "floor", reason: "beyond-depth" };
  }
  return {
    kind: "propagate",
    path: { paramIndex: base.paramIndex, members: combined },
  };
}

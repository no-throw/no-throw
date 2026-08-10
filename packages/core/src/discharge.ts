import ts from "typescript";
import type { FloorSource, UndischargedReason } from "./colors.js";
import {
  MAX_CONDITION_DEPTH,
  pathOf,
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

/**
 * What one of a callee's conditions comes to at one call site. `propagate` is
 * the genuinely new mechanism: the argument is itself reachable from the
 * caller's parameters, so the condition moves up instead of discharging, with
 * the callee's remaining segments appended to the caller's path.
 */
export type Outcome =
  | { readonly kind: "propagate"; readonly path: ParameterPath }
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
  const { checker } = resolution;
  const { paramIndex, members } = condition.path;

  const args = argumentsOf(transfer);
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
  const argumentPath = pathOf(argument, caller, checker);
  if (argumentPath !== undefined) return [propagate(argumentPath, members)];

  const receiver = resolveReceiver(argument, checker);
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

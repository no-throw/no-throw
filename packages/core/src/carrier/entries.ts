import ts from "typescript";
import { parseConditionPath } from "../baseline/paths.js";
import type { Color } from "../baseline/types.js";
import { parametersOf, type Condition } from "../conditions.js";
import type { Bodied } from "../declarations.js";
import type { ManifestEntry } from "./manifest.js";

/** An entry, read as the engine's own terms. */
export interface CarriedFacts {
  readonly color: Color;
  /**
   * Declaration emit erases `async`, so the carrier is the only thing that can
   * say a callee rejects rather than sync-throws. Absence must mean the safe
   * reading, and "might sync-throw" is it.
   */
  readonly async: boolean;
  readonly conditions: readonly Condition[];
}

/**
 * What an entry comes to for a callee, or nothing where the entry cannot be
 * used — a condition path outside the closed grammar, or one naming a shape
 * this engine has no form for. Either way the entry floors rather than being
 * read past, because the fact it was trying to state is the one that would
 * have made the callee clean.
 */
export function carriedFacts(
  declaration: Bodied,
  entry: ManifestEntry,
  checker: ts.TypeChecker,
): CarriedFacts | undefined {
  const color = entry.color;
  if (color === undefined) return undefined;

  const conditions =
    entry.conditions === undefined
      ? maximallyConditioned(declaration, checker)
      : declaredConditions(declaration, entry.conditions);
  if (conditions === undefined) return undefined;

  return { color, async: entry.async === true, conditions };
}

/**
 * Absence means *maximally conditioned*: every callable parameter, at
 * whole-value granularity. Unconditional cleanliness has to be recorded
 * positively as `[]`, so a carrier that forgets is over-strict, never a lie.
 */
function maximallyConditioned(
  declaration: Bodied,
  checker: ts.TypeChecker,
): readonly Condition[] {
  const conditions: Condition[] = [];

  parametersOf(declaration).forEach((parameter, paramIndex) => {
    if (parameter.dotDotDotToken !== undefined) return;
    if (!isCallable(checker.getTypeAtLocation(parameter), checker)) return;
    conditions.push({
      path: { paramIndex, members: [] },
      owner: declaration,
      entry: undefined,
    });
  });

  return conditions;
}

function declaredConditions(
  declaration: Bodied,
  paths: readonly string[],
): readonly Condition[] | undefined {
  const conditions: Condition[] = [];

  for (const path of paths) {
    const parsed = parseConditionPath(path);
    if (parsed === undefined) return undefined;

    const members: string[] = [];
    for (const segment of parsed.segments) {
      // `[]` and `.@@name` are in the wire grammar and have no engine form
      // yet, so a condition on one cannot be discharged at any call site.
      if (segment.kind !== "member") return undefined;
      members.push(segment.name);
    }

    conditions.push({
      path: { paramIndex: parsed.paramIndex, members },
      owner: declaration,
      entry: undefined,
    });
  }

  return conditions;
}

function isCallable(type: ts.Type, checker: ts.TypeChecker): boolean {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some(
    (part) => checker.getApparentType(part).getCallSignatures().length > 0,
  );
}

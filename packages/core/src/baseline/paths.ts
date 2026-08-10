import type { ConditionPath } from "./types.js";

/**
 * What the argument at a position has to be for the entry's color to hold.
 * `entered` is the ordinary reading — the member enters the path, so whatever
 * reaches it must itself be non-throwing. `nullish` is the other one: the
 * member enters nothing, because ECMA-262 returns before it can.
 */
export type Requirement = "entered" | "nullish";

/**
 * A parsed condition path. The root is always a parameter position — a
 * condition is a precondition on the argument in hand, so it can be discharged
 * at every call site.
 *
 * Segments belong to `entered` alone. A path *through* a value nothing reaches
 * describes no value, so the two are one shape and not two only where the
 * grammar allows it.
 */
export type ParsedConditionPath =
  | {
      readonly requires: "entered";
      readonly paramIndex: number;
      readonly segments: readonly PathSegment[];
    }
  | { readonly requires: "nullish"; readonly paramIndex: number };

export type PathSegment =
  | { readonly kind: "member"; readonly name: string }
  | { readonly kind: "symbol"; readonly name: string }
  | { readonly kind: "element" };

const ROOT = /^param(0|[1-9]\d*)/;
const SEGMENT = /^(?:\[\]|\.@@([A-Za-z_$][\w$]*)|\.([A-Za-z_$][\w$]*))/;
const NULLISH = "=nullish";

/**
 * Parse a wire-format condition path. Returns `undefined` for anything outside
 * the closed grammar — the caller floors the entry rather than guessing.
 */
export function parseConditionPath(
  path: ConditionPath,
): ParsedConditionPath | undefined {
  const root = ROOT.exec(path);
  if (root === null) return undefined;

  const paramIndex = Number(root[1]);
  let rest = path.slice(root[0].length);
  if (rest === NULLISH) return { requires: "nullish", paramIndex };

  const segments: PathSegment[] = [];
  while (rest.length > 0) {
    const match = SEGMENT.exec(rest);
    if (match === null) return undefined;
    if (match[1] !== undefined) segments.push({ kind: "symbol", name: match[1] });
    else if (match[2] !== undefined)
      segments.push({ kind: "member", name: match[2] });
    else segments.push({ kind: "element" });
    rest = rest.slice(match[0].length);
  }

  return { requires: "entered", paramIndex, segments };
}

export function formatConditionPath(parsed: ParsedConditionPath): ConditionPath {
  const root = `param${parsed.paramIndex}`;
  if (parsed.requires === "nullish") return root + NULLISH;

  let out = root;
  for (const segment of parsed.segments) {
    if (segment.kind === "element") out += "[]";
    else if (segment.kind === "symbol") out += `.@@${segment.name}`;
    else out += `.${segment.name}`;
  }
  return out;
}

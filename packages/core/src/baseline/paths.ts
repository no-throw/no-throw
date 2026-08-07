import type { ConditionPath } from "./types.js";

/**
 * A parsed condition path. The root is always a parameter position — a
 * condition is a precondition on the argument in hand, so it can be discharged
 * at every call site.
 */
export interface ParsedConditionPath {
  readonly paramIndex: number;
  readonly segments: readonly PathSegment[];
}

export type PathSegment =
  | { readonly kind: "member"; readonly name: string }
  | { readonly kind: "symbol"; readonly name: string }
  | { readonly kind: "element" };

const ROOT = /^param(0|[1-9]\d*)/;
const SEGMENT = /^(?:\[\]|\.@@([A-Za-z_$][\w$]*)|\.([A-Za-z_$][\w$]*))/;

/**
 * Parse a wire-format condition path. Returns `undefined` for anything outside
 * the closed grammar — the caller floors the entry rather than guessing.
 */
export function parseConditionPath(
  path: ConditionPath,
): ParsedConditionPath | undefined {
  const root = ROOT.exec(path);
  if (root === null) return undefined;

  const segments: PathSegment[] = [];
  let rest = path.slice(root[0].length);
  while (rest.length > 0) {
    const match = SEGMENT.exec(rest);
    if (match === null) return undefined;
    if (match[1] !== undefined) segments.push({ kind: "symbol", name: match[1] });
    else if (match[2] !== undefined)
      segments.push({ kind: "member", name: match[2] });
    else segments.push({ kind: "element" });
    rest = rest.slice(match[0].length);
  }

  return { paramIndex: Number(root[1]), segments };
}

export function formatConditionPath(parsed: ParsedConditionPath): ConditionPath {
  let out = `param${parsed.paramIndex}`;
  for (const segment of parsed.segments) {
    if (segment.kind === "element") out += "[]";
    else if (segment.kind === "symbol") out += `.@@${segment.name}`;
    else out += `.${segment.name}`;
  }
  return out;
}

import type { ProseHazard } from "./specs/hazards.js";

/**
 * A hazard is bucketed by the **shape of its throw condition**, never by the
 * name of the definition it is written in. #25 made that a soundness
 * requirement rather than a style: a name-keyed enum fails *silently in the
 * unsafe direction* the moment a name is misfiled, which is what produced #22's
 * six unsound `Atomics.*` entries. A shape it cannot recognise is `unknown`,
 * and `unknown` is throwing.
 */
export type ShapeId =
  /** "if X is not a Y" — a wrong-type guard the declared type may exclude. */
  | "brand"
  /** "if X is null" / "is not given" — a nullability guard. */
  | "nullish"
  /** "if X is not a valid …" against a closed set of names. */
  | "enumVal"
  /** Bounds on a number the declared type does not bound. */
  | "range"
  /** Text that has to parse: a selector, a name production, a URL. */
  | "parse"
  /** Same-origin and permission checks. */
  | "security"
  /** The receiver or document is in the wrong state; nothing types that. */
  | "state"
  /** The binding layer range-checks an `[EnforceRange]` argument. */
  | "enforceRange"
  /** Gecko annotates the member `[Throws]`. Presence only; absence says nothing. */
  | "gecko"
  /** The hazard budget ran out: more causes exist than were read. */
  | "truncated"
  | "unknown";

/** What the declared type must guarantee for the shape to be unreachable. */
export type Domain = "brand" | "non-nullish" | "enum";

export interface Shape {
  readonly id: ShapeId;
  readonly condition: string;
  readonly domain: Domain | undefined;
  /** The interface name a `brand` shape demands, when the prose names one. */
  readonly target: string | undefined;
}

const NOT_A_TYPE = /\bis not an?\s+(?:<[^>]*>)?([A-Z][A-Za-z]*)\b/;
const NULLISH = /\bis (?:null|not (?:given|present|provided))\b/i;
const ENUM_VALUE =
  /\bis not (?:a valid|one of|among)\b|\bdoes not (?:appear in|match any)\b/i;
const RANGE =
  /\b(negative|greater than|less than|out of range|exceeds|too (?:large|long|small)|index|size|length|count)\b/i;
const PARSE =
  /\b(pars(?:e|ing|ed)|does not match the .{0,40}production|is not a valid (?:selector|name|URL|attribute name)|serializ)/i;
const SECURITY = /\b(origin|cross-origin|permission|secure context|sandbox|opaque)\b/i;

export function shapeOf(hazard: ProseHazard): Shape {
  const condition = hazard.condition.trim();
  const bare = { condition, domain: undefined, target: undefined } as const;

  if (condition === "") return { ...bare, id: "unknown" };

  // Order matters, and it runs from the most specific readable structure to the
  // least: a condition that names both a type and a range is about the type.
  const brandTarget = NOT_A_TYPE.exec(condition)?.[1];
  if (brandTarget !== undefined) {
    return { id: "brand", condition, domain: "brand", target: brandTarget };
  }
  if (NULLISH.test(condition)) {
    return { id: "nullish", condition, domain: "non-nullish", target: undefined };
  }
  if (ENUM_VALUE.test(condition)) {
    return { id: "enumVal", condition, domain: "enum", target: undefined };
  }
  if (PARSE.test(condition)) return { ...bare, id: "parse" };
  if (SECURITY.test(condition)) return { ...bare, id: "security" };
  if (RANGE.test(condition)) return { ...bare, id: "range" };
  return { ...bare, id: "state" };
}

/**
 * IDL's one structural throw fact. `[EnforceRange]` makes the binding layer
 * range-check before the algorithm runs, and TypeScript declares the parameter
 * `number`, which bounds nothing — so it is reachable from a conformant call.
 */
export function enforceRangeShape(argument: string): Shape {
  return {
    id: "enforceRange",
    condition: `[EnforceRange] on ${argument}: the binding throws before any step runs`,
    domain: undefined,
    target: undefined,
  };
}

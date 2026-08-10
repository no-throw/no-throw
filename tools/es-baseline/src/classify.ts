import { formatConditionPath } from "@no-throw/core/baseline";
import type {
  Color,
  ConditionPath,
  LibMember,
  ParsedConditionPath,
  TypeDomains,
} from "@no-throw/core/baseline";
import type ts from "typescript";

import { DIALS, type DialValue, type Dials } from "./dials.js";
import { shapeOf, type Domain, type Shape } from "./shapes.js";
import type { Hazard, SpecBuiltin, SpecCorpus } from "./spec/extract.js";
import type { Operand } from "./spec/operands.js";
import { toTypedArrayIntrinsic } from "./typed-arrays.js";

export type SiteVerdict =
  | "type-excluded"
  | "trust-base"
  | "conditional"
  /**
   * Reachable on its own terms, and behind an early return on an absent
   * argument, so the position it names must get nothing for the entry's color
   * to hold. A verdict rather than a shape: it says nothing about what the
   * hazard *is*, only that ECMA-262 returns before it.
   */
  | "absent-conditional"
  | "type-reachable"
  | "review";

export interface ClassifiedSite {
  readonly verdict: SiteVerdict;
  readonly shape: Shape["id"];
  readonly rootOp: string;
  readonly rule: string;
  readonly dial: keyof Dials | undefined;
  /** What this site needs of the call to be unreachable; empty where nothing does. */
  readonly requires: readonly ParsedConditionPath[];
  readonly condition: string;
}

export interface Proposal {
  readonly member: LibMember;
  readonly spec: SpecBuiltin | undefined;
  readonly sites: readonly ClassifiedSite[];
  /** Absent when no spec clause was found: no entry, and therefore floor. */
  readonly color: Color | undefined;
  readonly conditions: readonly ConditionPath[] | undefined;
  readonly reviewSites: number;
}

/**
 * ECMA-402 is a *different* specification document — ECMA-262 defers to it in
 * prose, so its validation is structurally invisible to this corpus. The whole
 * family ships throwing. That is a coverage boundary, not a judgment call.
 */
const ECMA_402 = /^(toLocale|localeCompare$)/;

/** Interfaces that describe a primitive: their receiver runs no user code. */
const PRIMITIVE_OWNERS = new Set(["String", "Number", "Boolean", "BigInt", "Symbol"]);

/** Object-shaped hazards are unreachable on a value that carries no user code. */
const OBJECT_SHAPED = new Set<Shape["id"]>([
  "usercall",
  "iterator",
  "species",
  "proxy",
  "detach",
  "mutation",
  "notObject",
  "brand",
]);

const RANK: Record<SiteVerdict, number> = {
  "type-reachable": 5,
  review: 4,
  "absent-conditional": 3,
  conditional: 2,
  "trust-base": 1,
  "type-excluded": 0,
};

const NATIVE_ERROR = /^(EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError)/;

export function classifyMembers(
  members: readonly LibMember[],
  corpus: SpecCorpus,
  domains: TypeDomains,
  dials: Dials = DIALS,
): readonly Proposal[] {
  return members.map((member) => classifyMember(member, corpus, domains, dials));
}

/**
 * An accessor clause is named `get X` / `set X`, and the two family rewrites
 * below are about `X`. Splitting the prefix off is what lets
 * `get Uint8Array.prototype.length` reach `get %TypedArray%.prototype.length`,
 * which is where ECMA-262 actually defines the four typed-array getters.
 */
const ACCESSOR_CLAUSE = /^(get |set )/;

export function specFor(corpus: SpecCorpus, specKey: string): SpecBuiltin | undefined {
  const prefix = ACCESSOR_CLAUSE.exec(specKey)?.[1] ?? "";
  const name = specKey.slice(prefix.length);
  return (
    corpus.builtins.get(specKey) ??
    corpus.builtins.get(prefix + toTypedArrayIntrinsic(name)) ??
    corpus.builtins.get(prefix + name.replace(NATIVE_ERROR, "NativeError"))
  );
  // Deliberately no `get X` fallback for a member's *own* key: reading a
  // property is not a call, so an accessor's color belongs in the accessor fact
  // and nowhere else. Giving the member a color from its getter's clause would
  // ship a call claim about something that cannot be called.
}

function classifyMember(
  member: LibMember,
  corpus: SpecCorpus,
  domains: TypeDomains,
  dials: Dials,
): Proposal {
  const spec = specFor(corpus, member.specKey);
  if (spec === undefined) {
    return {
      member,
      spec: undefined,
      sites: [],
      color: undefined,
      conditions: undefined,
      reviewSites: 0,
    };
  }
  return { member, spec, ...classifyAgainstSpec(spec, member, domains, dials) };
}

export interface SpecVerdict {
  readonly sites: readonly ClassifiedSite[];
  readonly color: Color;
  readonly conditions: readonly ConditionPath[] | undefined;
  readonly reviewSites: number;
}

/**
 * One clause's verdict for one member. Split out because an accessor fact
 * needs the same judgment applied to the member's `get X` and `set X` clauses
 * rather than to the member's own.
 */
export function classifyAgainstSpec(
  spec: SpecBuiltin,
  member: LibMember,
  domains: TypeDomains,
  dials: Dials,
): SpecVerdict {
  const sites = spec.hazards.map((hazard) =>
    behindAnEarlyReturn(
      classifySite(hazard, member, domains, dials),
      hazard,
      spec,
      member,
    ),
  );
  if (ECMA_402.test(member.name)) {
    sites.push({
      verdict: "type-reachable",
      shape: "unknown",
      rootOp: "ECMA-402",
      rule: "locale validation lives in ECMA-402, outside the extraction corpus",
      dial: undefined,
      requires: [],
      condition: "(no ECMA-262 algorithm covers the locale arguments)",
    });
  }

  const worst = sites.reduce<SiteVerdict>(
    (accumulated, site) =>
      RANK[site.verdict] > RANK[accumulated] ? site.verdict : accumulated,
    "type-excluded",
  );

  if (worst === "type-reachable" || worst === "review") {
    return {
      sites,
      color: "throwing",
      conditions: undefined,
      reviewSites: sites.filter((site) => site.verdict === "review").length,
    };
  }

  const required = sites.flatMap((site) => site.requires);
  const absent = new Set(
    required.filter((one) => one.requires === "nullish").map((one) => one.paramIndex),
  );

  const conditions = [
    ...new Set(
      required
        // A position nothing reaches is a position no path through it is
        // entered at, so an `entered` condition rooted there states a second
        // requirement the first has already made unmeetable: the call site
        // would have to pass a clean function *and* pass nothing.
        .filter((one) => one.requires === "nullish" || !absent.has(one.paramIndex))
        .map(formatConditionPath),
    ),
  ].sort();

  return { sites, color: "non-throwing", conditions, reviewSites: 0 };
}

/**
 * The early-return reading, applied over the shape reading rather than inside
 * it. A hazard behind `If iterable is either undefined or null, return map` is
 * unreachable when the call passes nothing there, whatever the hazard is — and
 * a site the declared types already discharge needs no condition, so only the
 * ones that would otherwise make the member throwing are moved.
 *
 * Every guarding name must be a parameter of the member. Requiring all of them
 * rather than any is over-strict where two guards protect one site — the site
 * needs only one of them to fire — and over-strict is the safe direction.
 */
function behindAnEarlyReturn(
  site: ClassifiedSite,
  hazard: Hazard,
  spec: SpecBuiltin,
  member: LibMember,
): ClassifiedSite {
  if (site.verdict !== "type-reachable" && site.verdict !== "review") {
    return site;
  }

  const positions = hazard.given.map((name) => spec.params.indexOf(name));
  if (
    positions.length === 0 ||
    positions.some((index) => index < 0 || member.params?.[index] === undefined)
  ) {
    return site;
  }

  return {
    ...site,
    verdict: "absent-conditional",
    rule: `${site.rule}; unreachable where ${hazard.given.join(" and ")} is absent`,
    requires: positions.map((paramIndex) => ({
      requires: "nullish" as const,
      paramIndex,
    })),
  };
}

function classifySite(
  hazard: Hazard,
  member: LibMember,
  domains: TypeDomains,
  dials: Dials,
): ClassifiedSite {
  const shape = shapeOf(hazard);
  const operand = resolveOperand(hazard.operand, member, domains);
  const base = {
    shape: shape.id,
    rootOp: shape.rootOp,
    condition: shape.condition,
  } as const;
  const verdict = (
    value: SiteVerdict,
    rule: string,
    extra: { dial?: keyof Dials; path?: ParsedConditionPath } = {},
  ): ClassifiedSite => ({
    ...base,
    verdict: value,
    rule,
    dial: extra.dial,
    requires: extra.path === undefined ? [] : [extra.path],
  });

  const fromDial = (dial: keyof Dials, rule: string): ClassifiedSite => {
    const value: DialValue = dials[dial];
    if (value === "trust-base") return verdict("trust-base", rule, { dial });
    if (value === "path" && operand.path !== undefined) {
      return verdict("conditional", rule, { dial, path: operand.path });
    }
    return verdict("type-reachable", rule, { dial });
  };

  if (operand.primitive && OBJECT_SHAPED.has(shape.id)) {
    return verdict(
      "type-excluded",
      `${shape.id} needs an object; ${operand.describe} carries no user code`,
    );
  }

  switch (shape.id) {
    case "usercall":
      if (operand.path !== undefined && domains.isCallable(operand.types)) {
        return verdict("conditional", `enters ${formatConditionPath(operand.path)}`, {
          path: operand.path,
        });
      }
      if (operand.kind === "static-receiver") {
        return fromDial("subclassHooks", "invokes a method reached via `this`");
      }
      if (operand.kind === "receiver") {
        return fromDial(
          "nullPrototype",
          "invokes a method off the receiver's prototype chain",
        );
      }
      return fromDial(
        "memberCallable",
        "invokes a method reached through a declared value",
      );
    case "iterator":
      return fromDial(
        "memberCallable",
        "drives a user-supplied iterator or set-like protocol",
      );
    case "species":
      return fromDial("subclassHooks", "runs constructor[Symbol.species]");
    case "proxy":
      return fromDial(
        "proxyTraps",
        "property access: traps are invisible to the type system",
      );
    case "detach":
      return fromDial(
        "detachedBuffer",
        "a detached or out-of-bounds buffer is type-conformant",
      );
    case "newtarget":
      return verdict(
        "type-excluded",
        "call-vs-construct is fixed by the declaration",
      );
    case "range":
      return verdict(
        "type-reachable",
        `range check on ${operand.describe}; the declared type does not bound it`,
      );
    case "enumVal":
      return verdict(
        "type-reachable",
        `enumerated-value check on ${operand.describe}`,
      );
    case "parse":
      return verdict("type-reachable", "parses text; validity is not a type");
    case "state":
      return verdict(
        "type-reachable",
        `value- or state-dependent: ${shape.condition.slice(0, 60)}`,
      );
    case "mutation":
      return verdict(
        "type-reachable",
        "mutates a receiver; frozen and sealed are type-conformant",
      );
    case "unknown":
      return verdict(
        "review",
        `unbucketed condition shape: ${shape.condition.slice(0, 90)}`,
      );
    default: {
      if (shape.domain === undefined) {
        return verdict("review", `no domain test for shape ${shape.id}`);
      }
      // A guard on the constructor reached through `this`: only a subclass can
      // fail it, which is the subclass-hook question, not this one.
      if (operand.kind === "static-receiver") {
        return fromDial(
          "subclassHooks",
          `${shape.id} on the constructor reached via \`this\``,
        );
      }
      return domainHolds(shape.domain, operand, member, domains)
        ? verdict("type-excluded", `${shape.id} discharged by ${operand.describe}`)
        : verdict(
            "type-reachable",
            `${shape.id} not discharged by ${operand.describe}`,
          );
    }
  }
}

interface ResolvedOperand {
  readonly kind: "param" | "receiver" | "static-receiver" | "unresolved";
  readonly types: readonly ts.Type[];
  /** Set only when the operand is expressible as a condition on a parameter. */
  readonly path: ParsedConditionPath | undefined;
  readonly primitive: boolean;
  readonly optional: boolean;
  readonly describe: string;
}

const UNRESOLVED: ResolvedOperand = {
  kind: "unresolved",
  types: [],
  path: undefined,
  primitive: false,
  optional: false,
  describe: "an engine-internal value",
};

function resolveOperand(
  operand: Operand,
  member: LibMember,
  domains: TypeDomains,
): ResolvedOperand {
  if (operand.root === "receiver") {
    const receiver = member.receiverType;
    if (receiver === undefined) return UNRESOLVED;
    const walked = walkSegments([receiver], operand, domains);
    if (walked === undefined) return UNRESOLVED;
    const bare = operand.segments.length === 0;
    return {
      kind: member.isStatic ? "static-receiver" : "receiver",
      types: walked,
      path: undefined,
      primitive:
        (bare && PRIMITIVE_OWNERS.has(member.receiverOwner)) ||
        domains.isPrimitive(walked),
      optional: false,
      describe: `receiver ${member.receiverOwner}${describeSegments(operand)}`,
    };
  }

  if (operand.root !== "param") return UNRESOLVED;
  const param = member.params?.[operand.index];
  if (param === undefined || param.types.length === 0) return UNRESOLVED;
  const walked = walkSegments(param.types, operand, domains);
  if (walked === undefined) return UNRESOLVED;

  // A rest parameter's path root is ambiguous at a call site — `param0` there
  // names the first rest argument, not the list — so it carries a type but
  // never a condition.
  const path = param.rest ? undefined : conditionPathOf(operand);
  return {
    kind: "param",
    types: walked,
    path,
    primitive: domains.isPrimitive(walked),
    optional: param.optional,
    describe: `parameter ${param.name}${describeSegments(operand)}`,
  };
}

function walkSegments(
  roots: readonly ts.Type[],
  operand: Operand,
  domains: TypeDomains,
): readonly ts.Type[] | undefined {
  let current = [...roots];
  for (const segment of operand.segments) {
    const next: ts.Type[] = [];
    for (const type of current) {
      const resolved =
        segment.kind === "element"
          ? domains.elementTypeOf(type)
          : segment.kind === "symbol"
            ? domains.symbolPropertyTypeOf(type, segment.name)
            : domains.propertyTypeOf(type, segment.name);
      if (resolved === undefined) return undefined;
      next.push(resolved);
    }
    current = next;
  }
  return current;
}

function conditionPathOf(operand: Operand): ParsedConditionPath | undefined {
  if (operand.root !== "param" || operand.index < 0) return undefined;
  return {
    requires: "entered",
    paramIndex: operand.index,
    segments: operand.segments,
  };
}

function describeSegments(operand: Operand): string {
  return operand.segments
    .map((segment) =>
      segment.kind === "element"
        ? "[]"
        : segment.kind === "symbol"
          ? `.@@${segment.name}`
          : `.${segment.name}`,
    )
    .join("");
}

function domainHolds(
  domain: Domain,
  operand: ResolvedOperand,
  member: LibMember,
  domains: TypeDomains,
): boolean {
  if (operand.kind === "unresolved") return false;
  const isReceiver = operand.kind === "receiver";
  switch (domain) {
    case "callable":
      return domains.isCallable(operand.types);
    case "constructor":
      return (
        domains.isConstructor(operand.types) || domains.isCallable(operand.types)
      );
    case "non-nullish":
      return isReceiver
        ? true
        : domains.isNonNullish(operand.types) && !operand.optional;
    case "coercible":
      return isReceiver ? operand.primitive : domains.isCoercible(operand.types);
    case "primitive":
      return operand.primitive;
    case "object":
      return isReceiver ? true : domains.isObject(operand.types);
    case "string":
      return isReceiver
        ? member.receiverOwner === "String"
        : domains.isString(operand.types);
    case "symbol":
      return isReceiver
        ? member.receiverOwner === "Symbol"
        : domains.isSymbol(operand.types);
    // The declaring interface *is* the brand, and `ArrayBuffer` and
    // `SharedArrayBuffer` are distinct declared types.
    case "brand":
    case "buffer-kind":
      return isReceiver;
  }
}

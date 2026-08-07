import type { Color, DomMember, TypeDomains } from "@nothrow/core/baseline";
import type ts from "typescript";

import type { IdlArg, IdlRow } from "./idl/corpus.js";
import type { MemberEvidence } from "./prose.js";
import { enforceRangeShape, shapeOf, type Domain, type Shape } from "./shapes.js";
import type { ProseHazard } from "./specs/hazards.js";

export type SiteVerdict = "type-excluded" | "type-reachable" | "review";

export interface ClassifiedSite {
  readonly verdict: SiteVerdict;
  readonly shape: Shape["id"];
  readonly rule: string;
  readonly exception: string;
  readonly condition: string;
  /** Where the throw is written, for the audit trail. */
  readonly at: string;
  /**
   * Which half of an attribute this site belongs to, so an accessor fact can
   * colour get and set independently (#29 §1). `both` for everything that is
   * not an attribute.
   */
  readonly phase: "get" | "set" | "both";
}

export interface Proposal {
  readonly member: DomMember;
  /** The prose definition this was adjudicated from. Audit trail. */
  readonly dfnKey: string | undefined;
  readonly sites: readonly ClassifiedSite[];
  /** Absent when no prose definition was found: no entry, and therefore floor. */
  readonly color: Color | undefined;
  readonly reviewSites: number;
  /** Parameter positions control can reach into. The deferred probe adjudicates them. */
  readonly callableParams: readonly number[];
  readonly truncated: boolean;
}

const RANK: Record<SiteVerdict, number> = {
  "type-reachable": 2,
  review: 1,
  "type-excluded": 0,
};

export function classifyMembers(
  evidence: readonly MemberEvidence[],
  domains: TypeDomains,
  geckoThrows: ReadonlySet<string>,
): readonly Proposal[] {
  return evidence.map((entry) => classifyMember(entry, domains, geckoThrows));
}

function classifyMember(
  entry: MemberEvidence,
  domains: TypeDomains,
  geckoThrows: ReadonlySet<string>,
): Proposal {
  const { member, idl } = entry.joined;
  const callableParams = (member.params ?? []).flatMap((parameter, index) =>
    domains.mayBeCallable(parameter.types) ? [index] : [],
  );

  if (entry.prose === undefined) {
    return {
      member,
      dfnKey: undefined,
      sites: [],
      color: undefined,
      reviewSites: 0,
      callableParams,
      truncated: false,
    };
  }

  const sites = entry.prose.hazards.map((hazard) =>
    classifySite(hazard, member, idl, domains),
  );

  // IDL's only structural throw fact, and it is a *throwing* one.
  for (const argument of idl?.args ?? []) {
    if (!argument.enforceRange) continue;
    const shape = enforceRangeShape(argument.name);
    sites.push({
      verdict: "type-reachable",
      shape: shape.id,
      rule: "the binding range-checks before any step runs; `number` bounds nothing",
      exception: "TypeError",
      condition: shape.condition,
      at: "WebIDL binding layer",
      phase: "both",
    });
  }

  // Gecko is a **one-way** oracle (#26). Presence of `[Throws]` is a sound
  // throwing signal; absence is one implementation's behaviour and is never
  // read here at all, which is why nothing below ever moves a site toward
  // `type-excluded`.
  if (geckoThrows.has(member.key)) {
    sites.push({
      verdict: "type-reachable",
      shape: "gecko",
      rule: "Gecko annotates this member `[Throws]` — presence is a sound throwing signal",
      exception: "unknown",
      condition: "(one implementation's annotation; absence would prove nothing)",
      at: "Gecko dom/webidl",
      phase: "both",
    });
  }

  // A truncated hazard set means *more* hazards than were read, never fewer,
  // so it can only be resolved in the throwing direction.
  if (entry.prose.truncated) {
    sites.push({
      verdict: "type-reachable",
      shape: "truncated",
      rule: "the hazard budget ran out: this member has more causes than were read",
      exception: "unknown",
      condition: "(hazard set truncated)",
      at: entry.prose.dfnKey,
      phase: "both",
    });
  }

  const worst = sites.reduce<SiteVerdict>(
    (accumulated, site) =>
      RANK[site.verdict] > RANK[accumulated] ? site.verdict : accumulated,
    "type-excluded",
  );

  return {
    member,
    dfnKey: entry.prose.dfnKey,
    sites,
    color: worst === "type-excluded" ? "non-throwing" : "throwing",
    reviewSites: sites.filter((site) => site.verdict === "review").length,
    callableParams,
    truncated: entry.prose.truncated,
  };
}

function classifySite(
  hazard: ProseHazard,
  member: DomMember,
  idl: IdlRow | undefined,
  domains: TypeDomains,
): ClassifiedSite {
  const shape = shapeOf(hazard);
  const site = (verdict: SiteVerdict, rule: string): ClassifiedSite => ({
    verdict,
    shape: shape.id,
    rule,
    exception: hazard.exception,
    condition: hazard.condition.slice(-160),
    at: hazard.atKey,
    phase: hazard.phase,
  });

  if (shape.id === "unknown") {
    return site("review", "unbucketed condition shape");
  }
  if (shape.domain === undefined) {
    return site("type-reachable", `${shape.id}: no declared type bounds this`);
  }

  const operand = resolveOperand(hazard, member, idl);
  if (operand === undefined) {
    // Prose that never names the value it is about is untraceable, and an
    // untraceable hazard is reachable. There is no third answer.
    return site(
      "type-reachable",
      `${shape.id} on a value the prose does not name`,
    );
  }

  return domainHolds(shape.domain, shape.target, operand, domains)
    ? site("type-excluded", `${shape.id} discharged by ${operand.describe}`)
    : site("type-reachable", `${shape.id} not discharged by ${operand.describe}`);
}

interface ResolvedOperand {
  readonly types: readonly ts.Type[];
  readonly optional: boolean;
  readonly describe: string;
}

/**
 * The DOM analogue of #22's operand tracing. ECMA-262 numbers its parameters
 * and the extractor walks assignments; Bikeshed prose refers to an argument by
 * the very name IDL gives it, so the IDL argument list *is* the namespace, and
 * the declared TypeScript type at that position is what discharges the hazard.
 * A condition naming nothing resolves to nothing, and stays reachable.
 */
function resolveOperand(
  hazard: ProseHazard,
  member: DomMember,
  idl: IdlRow | undefined,
): ResolvedOperand | undefined {
  const condition = hazard.condition;
  const args: readonly IdlArg[] = idl?.args ?? [];

  for (const [index, argument] of args.entries()) {
    if (argument.name === "" || !namesValue(condition, argument.name)) continue;
    // A possessive reaches *past* the argument — "node's parent is not a
    // Document" is about the parent, which no declared type describes.
    if (new RegExp(`\\b${escape(argument.name)}\\b\\s*['’]s\\b`).test(condition)) {
      return undefined;
    }
    const parameter = member.params?.[index];
    if (parameter === undefined || parameter.types.length === 0) return undefined;
    return {
      types: parameter.types,
      optional: parameter.optional,
      describe: `parameter ${parameter.name}`,
    };
  }

  if (/\b(this|the context object|the receiver)\b/i.test(condition)) {
    const receiver = member.receiverType;
    if (receiver === undefined || member.isStatic) return undefined;
    return {
      types: [receiver],
      optional: false,
      describe: `receiver ${member.owner}`,
    };
  }

  return undefined;
}

function namesValue(condition: string, name: string): boolean {
  return new RegExp(`\\b${escape(name)}\\b`).test(condition);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function domainHolds(
  domain: Domain,
  target: string | undefined,
  operand: ResolvedOperand,
  domains: TypeDomains,
): boolean {
  switch (domain) {
    case "non-nullish":
      return domains.isNonNullish(operand.types) && !operand.optional;
    case "enum":
      // A closed set of names is exactly what a string-literal union is; a bare
      // `string` promises nothing about its contents.
      return domains.isStringLiteralUnion(operand.types);
    case "brand":
      // The declared type is the brand only if the prose names a type and the
      // declared type is that type or a subtype of it. Anything wider — `any`,
      // a union with a non-matching arm — leaves the guard reachable.
      return target !== undefined && domains.isExactly(operand.types, target);
  }
}

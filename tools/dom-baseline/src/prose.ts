import { CONSTRUCT_SEGMENT } from "@no-throw/core/baseline";

import type { IdlCorpus } from "./idl/corpus.js";
import type { JoinedMember, RuntimeOwner } from "./join.js";
import type { Dfn, DfnGraph } from "./specs/dfns.js";
import { hazardsOf, memberDfnIndex, type MemberProse } from "./specs/hazards.js";

/**
 * The join from a declared member to the prose that defines it. Attribution is
 * free — Bikeshed's `data-dfn-for` names the interface — but the name a
 * definition is filed under is the *IDL* interface, which is not always the
 * TypeScript one: `lib.dom.d.ts` keeps some mixins as interfaces and flattens
 * others into their host, and invents `NodeListOf`.
 */
export interface MemberEvidence {
  readonly joined: JoinedMember;
  /** Absent when no prose definition was found — the member floors. */
  readonly prose: MemberProse | undefined;
}

export interface ProseJoinReport {
  readonly evidence: readonly MemberEvidence[];
  readonly stats: {
    readonly withProse: number;
    readonly withoutProse: number;
    readonly hazardous: number;
    readonly hazardFree: number;
    readonly truncated: number;
    readonly medianVisited: number;
  };
}

export function attachProse(
  joined: readonly JoinedMember[],
  graph: DfnGraph,
  corpus: IdlCorpus,
  bases: ReadonlyMap<string, readonly string[]> = new Map(),
  runtimeOwner: RuntimeOwner = () => undefined,
): ProseJoinReport {
  const index = memberDfnIndex(graph);
  const visitedCounts: number[] = [];

  const evidence = joined.map((entry) => {
    const dfn = lookup(entry, corpus, index, bases, runtimeOwner);
    if (dfn === undefined) return { joined: entry, prose: undefined };
    const prose = hazardsOf(graph, dfn);
    if (prose !== undefined) visitedCounts.push(prose.visited);
    return { joined: entry, prose };
  });

  const withProse = evidence.filter((entry) => entry.prose !== undefined);
  visitedCounts.sort((left, right) => left - right);

  return {
    evidence,
    stats: {
      withProse: withProse.length,
      withoutProse: evidence.length - withProse.length,
      hazardous: withProse.filter((entry) => (entry.prose?.hazards.length ?? 0) > 0).length,
      hazardFree: withProse.filter((entry) => entry.prose?.hazards.length === 0).length,
      truncated: withProse.filter((entry) => entry.prose?.truncated === true).length,
      medianVisited: visitedCounts[Math.floor(visitedCounts.length / 2)] ?? 0,
    },
  };
}

function lookup(
  entry: JoinedMember,
  corpus: IdlCorpus,
  index: ReadonlyMap<string, Dfn>,
  bases: ReadonlyMap<string, readonly string[]>,
  runtimeOwner: RuntimeOwner,
): string | undefined {
  const { member, idl } = entry;
  // CSSOM declares its ~500 CSS-property attributes once, under a placeholder
  // name, and says every supported property has one. That single definition is
  // the algorithm for all of them, so it is the right attribution rather than a
  // convenience: without it the whole of `element.style` floors.
  if (entry.structure === "cssom-generated") {
    return (
      index.get("cssstyleproperties.camel_cased_attribute")?.key ??
      index.get("cssstyledeclaration.camel_cased_attribute")?.key
    );
  }
  const name = member.name === CONSTRUCT_SEGMENT ? "constructor" : member.name;
  const owners = [
    ...(idl === undefined ? [] : [idl.viaMixin ?? idl.owner, idl.owner]),
    member.owner,
    ...(/^(\w+)Of$/.exec(member.owner)?.slice(1) ?? []),
    ...(corpus.mixinsOf.get(member.owner) ?? []),
    // A redeclaration inherits the base's definition; see `candidateOwners`.
    ...(member.isStatic ? [] : (bases.get(member.owner) ?? [])),
    ...(runtimeOwner(member) === undefined ? [] : [runtimeOwner(member) as string]),
  ];
  for (const owner of owners) {
    const dfn = index.get(`${owner}.${name}`.toLowerCase());
    if (dfn !== undefined) return dfn.key;
  }
  return undefined;
}

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  TypeDomains,
  collectDomMembers,
  type AccessorFact,
  type BaselineData,
  type BaselineEntry,
  type ConditionPath,
  type DomMember,
} from "@no-throw/core/baseline";
import ts from "typescript";

import { accessorFactFor, type AccessorRecord } from "./accessors.js";
import { classifyMembers, type Proposal } from "./classify.js";
import { createDomProgram } from "./lib.js";
import { geckoThrowingKeys } from "./gecko.js";
import { DeferredProbe, type DeferredVerdict } from "./gates/deferred.js";
import { currentSymbolSet, recordedSymbolSetPath } from "./gates/drift.js";
import { createDomEnvironment, runtimeOwnerOf } from "./gates/environment.js";
import type { Counterexample } from "./gates/fuzz.js";
import { runFuzzGate, type Claim, type GateReport } from "./gates/run.js";
import { loadIdlCorpus } from "./idl/corpus.js";
import { joinToIdl, type Structure } from "./join.js";
import { attachProse } from "./prose.js";
import { REFUTED_KEYS } from "./refutations.js";
import { buildDfnGraph, type DfnGraph } from "./specs/dfns.js";
import { buildWorklist, type Worklist } from "./worklist.js";

const OUTPUT = new URL(
  "../../../packages/core/baseline-data/dom.json",
  import.meta.url,
);

export interface GenerationReport {
  readonly data: BaselineData;
  /** Counterexamples with no recorded refutation. These fail the build. */
  readonly counterexamples: readonly Counterexample[];
  /** Recorded refutations the gate probed and could not reproduce. */
  readonly staleRefutations: readonly string[];
  /**
   * Recorded refutations the gate never got to probe, because the member is no
   * longer proposed clean. Not stale — unexercised — but reported, because a
   * record nothing checks is a record that can rot unnoticed.
   */
  readonly unexercisedRefutations: readonly string[];
  readonly gate: GateReport;
  readonly worklist: Worklist;
  readonly summary: {
    readonly members: number;
    readonly idlBacked: number;
    readonly withProse: number;
    readonly clean: number;
    readonly conditional: number;
    readonly relaxations: number;
    readonly throwing: number;
    readonly cleanReads: number;
    readonly accessorFacts: number;
    readonly dataNessRecords: number;
    readonly floored: number;
    readonly reviewMembers: number;
    /** Hazard sites by condition shape — the buckets a reviewer signs off on. */
    readonly shapes: readonly (readonly [shape: string, count: number])[];
    /** The rules that made members throwing, largest first. */
    readonly topRules: readonly (readonly [rule: string, count: number])[];
    readonly geckoThrows: number;
    readonly unprobed: number;
    readonly throwBearingExtAttrs: number;
    /**
     * Passed through from {@link DfnGraph.stats}, and printed beside the
     * extended-attribute count: the other number kept for what its *absence*
     * would mean rather than for its value.
     */
    readonly memberDefinitionsByForm: DfnGraph["stats"]["memberDefinitionsByForm"];
  };
}

export async function generateBaseline(): Promise<GenerationReport> {
  const lib = createDomProgram(ts);
  const inventory = collectDomMembers(lib);
  const domains = new TypeDomains(lib);

  // The environment comes first because attribution needs it: a member's real
  // owner is sometimes only readable off the live prototype chain.
  const environment = createDomEnvironment();
  const runtimeOwner = (member: DomMember): string | undefined =>
    runtimeOwnerOf(environment, member, inventory.implementers);

  const corpus = await loadIdlCorpus();
  const { joined } = joinToIdl(inventory.members, corpus, inventory.bases, runtimeOwner);
  const graph = buildDfnGraph();
  const { evidence } = attachProse(
    joined,
    graph,
    corpus,
    inventory.bases,
    runtimeOwner,
  );
  const gecko = geckoThrowingKeys();
  const proposals = classifyMembers(evidence, domains, gecko);
  const proposalOf = new Map(proposals.map((proposal) => [proposal.member.key, proposal]));

  const accessors = new Map<string, AccessorRecord>();
  for (const entry of evidence) {
    const proposal = proposalOf.get(entry.joined.member.key);
    if (proposal === undefined) continue;
    const record = accessorFactFor(
      entry.joined,
      proposal,
      environment,
      inventory.implementers,
    );
    if (record !== undefined) accessors.set(record.key, record);
  }

  // The terminal open item, closed before the data ships: every callback-taking
  // member is adjudicated, and a member the probe cannot reach floors.
  const probe = new DeferredProbe(lib, inventory.implementers, environment);
  const verdicts: DeferredVerdict[] = [];
  for (const proposal of proposals) {
    for (const paramIndex of proposal.callableParams) {
      verdicts.push(await probe.adjudicate(proposal.member, paramIndex));
    }
  }
  const verdictsOf = new Map<string, DeferredVerdict[]>();
  for (const verdict of verdicts) {
    (verdictsOf.get(verdict.key) ?? put(verdictsOf, verdict.key)).push(verdict);
  }

  // Proposed claims first, then the gate, then the entries: an unprobed clean
  // claim must never reach the data.
  const draft = new Map<string, Claim>();
  const throwing = new Set<string>();
  for (const proposal of proposals) {
    const fact = accessors.get(proposal.member.key)?.fact;
    draft.set(proposal.member.key, {
      cleanCall: isCleanCall(proposal, verdictsOf.get(proposal.member.key)),
      cleanGet: fact !== undefined && fact !== false && fact.get === "non-throwing",
    });
    if (proposal.color === "throwing") throwing.add(proposal.member.key);
  }

  const gate = await runFuzzGate(
    lib,
    inventory.members,
    inventory.implementers,
    draft,
    throwing,
    environment,
  );
  const refuted = new Set(gate.counterexamples.map((found) => found.key));
  // A recorded refutation is stale only when the gate *had the chance* to
  // reproduce it and did not. A member no longer proposed clean is not probed
  // at all, which says nothing about the refutation.
  const probedClean = new Set(gate.probed.map((result) => result.key));
  const unprobedCalls = new Set(
    gate.unprobed.filter((result) => result.probe === "call").map((result) => result.key),
  );
  const unprobedGets = new Set(
    gate.unprobed.filter((result) => result.probe === "get").map((result) => result.key),
  );

  const structureOf = new Map<string, Structure>(
    joined.map((entry) => [entry.member.key, entry.structure]),
  );
  const byMember = new Map<string, BaselineEntry>();
  for (const member of inventory.members) {
    const entry = entryFor(
      member,
      structureOf.get(member.key),
      proposalOf.get(member.key),
      accessors.get(member.key),
      verdictsOf.get(member.key) ?? [],
      {
        unprobedCall: unprobedCalls.has(member.key),
        unprobedGet: unprobedGets.has(member.key),
        refuted: refuted.has(member.key) || REFUTED_KEYS.has(member.key),
      },
    );
    if (entry !== undefined) byMember.set(member.key, entry);
  }

  const libs: Record<string, Record<string, BaselineEntry>> = {};
  for (const member of inventory.members) {
    const entry = byMember.get(member.key);
    if (entry === undefined) continue;
    for (const target of member.libs) (libs[target] ??= {})[member.key] = entry;
  }

  const data: BaselineData = {
    version: 1,
    unprobed: [...new Set([...unprobedCalls, ...unprobedGets])].sort(),
    libs: sortKeys(libs),
  };

  environment.close();

  return {
    data,
    counterexamples: gate.counterexamples.filter((found) => !REFUTED_KEYS.has(found.key)),
    staleRefutations: [...REFUTED_KEYS].filter(
      (key) => probedClean.has(key) && !refuted.has(key),
    ),
    unexercisedRefutations: [...REFUTED_KEYS].filter((key) => !probedClean.has(key)),
    gate,
    worklist: buildWorklist(verdicts, ts.version, "jsdom"),
    summary: summarize(
      inventory.members,
      joined.filter((entry) => entry.structure === "idl").length,
      evidence.filter((entry) => entry.prose !== undefined).length,
      proposals,
      accessors,
      verdicts,
      byMember,
      gecko.size,
      data.unprobed.length,
      corpus.stats.throwBearingExtAttrs.length,
      graph.stats.memberDefinitionsByForm,
    ),
  };
}

function put<T>(map: Map<string, T[]>, key: string): T[] {
  const created: T[] = [];
  map.set(key, created);
  return created;
}

/**
 * A callable member is proposed clean only when the prose discharges every
 * hazard *and* every parameter control can reach into has been adjudicated. An
 * unadjudicated callback is the fake-bridge hazard itself, so it floors.
 */
function isCleanCall(
  proposal: Proposal,
  verdicts: readonly DeferredVerdict[] | undefined,
): boolean {
  if (proposal.color !== "non-throwing") return false;
  if (!isCallableKind(proposal.member.kind)) return false;
  const adjudicated = new Map(
    (verdicts ?? []).map((verdict) => [verdict.paramIndex, verdict.adjudication]),
  );
  return proposal.callableParams.every(
    (index) => (adjudicated.get(index) ?? "unreachable") !== "unreachable",
  );
}

function isCallableKind(kind: DomMember["kind"]): boolean {
  return kind === "method" || kind === "construct" || kind === "call" || kind === "function";
}

interface GateOutcome {
  readonly unprobedCall: boolean;
  readonly unprobedGet: boolean;
  readonly refuted: boolean;
}

function entryFor(
  member: DomMember,
  structure: Structure | undefined,
  proposal: Proposal | undefined,
  accessor: AccessorRecord | undefined,
  verdicts: readonly DeferredVerdict[],
  gate: GateOutcome,
): BaselineEntry | undefined {
  const fact = gatedAccessorFact(accessor, gate.unprobedGet);
  const color = colorFor(member, proposal, verdicts, gate);
  if (color === undefined && fact === undefined) return undefined;

  const clean = color === "non-throwing";
  return {
    ...(color === undefined ? {} : { color }),
    ...(clean ? { conditions: conditionsOf(verdicts) } : {}),
    ...(fact === undefined ? {} : { accessor: fact }),
    ...(proposal?.dfnKey === undefined ? {} : { spec: proposal.dfnKey }),
    // A dictionary is an object literal and a TypeScript map interface is a
    // type-level fiction; neither has a prototype to name, so claiming a
    // runtime path for one would be an audit trail that leads nowhere.
    ...(structure === "dictionary" || structure === "ts-map"
      ? {}
      : { runtime: member.runtimePath }),
  };
}

function colorFor(
  member: DomMember,
  proposal: Proposal | undefined,
  verdicts: readonly DeferredVerdict[],
  gate: GateOutcome,
): BaselineEntry["color"] {
  if (proposal === undefined || !isCallableKind(member.kind)) return undefined;
  // A *refuted* clean ships throwing: there the gate knows something.
  if (gate.refuted) return "throwing";
  if (proposal.color === "throwing") return "throwing";
  if (proposal.color === undefined) return undefined;
  // Prose found nothing, but that is only half an answer. An unprobed claim and
  // an unadjudicated callback are both *no* answer rather than a throwing one,
  // so the color is simply absent — and absence floors.
  return gate.unprobedCall || !isCleanCall(proposal, verdicts)
    ? undefined
    : "non-throwing";
}

/**
 * Which parameters stay conditions. A `sync` verdict keeps the parameter — the
 * callback runs inside the call, so its color is the caller's problem at the
 * call site. A `queued` one drops it, and a member all of whose callbacks are
 * queued ends up with `conditions: []`: the relaxation entry that keeps
 * `try { el.addEventListener('x', risky) } catch {}` from being a reachable
 * fake bridge (#21, #30 §E).
 */
function conditionsOf(
  verdicts: readonly DeferredVerdict[],
): readonly ConditionPath[] {
  const sync = new Set(
    verdicts
      .filter((verdict) => verdict.adjudication === "sync")
      .map((verdict) => verdict.path),
  );
  return [...sync].sort();
}

/**
 * There is no write probe: assigning to a shared builtin receiver would corrupt
 * every later probe, so `set` is never clean. That is not a shortcut — it is
 * the unprobed-ships-floored rule applied to the half of an accessor the gate
 * cannot attack, and it is exactly the asymmetry #29 §1 asks for.
 */
function gatedAccessorFact(
  record: AccessorRecord | undefined,
  unprobedGet: boolean,
): AccessorFact | undefined {
  if (record === undefined) return undefined;
  const fact = record.fact;
  if (fact === false) return fact;
  // A data property read runs no code, so the gate has nothing to refute and
  // its inability to reach one is not evidence about anything.
  const downgrade = unprobedGet && !record.dataProperty;
  return { get: downgrade ? "throwing" : fact.get, set: "throwing" };
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * #25 is normative: the generator hands over the whole hazard set and signs
 * *hazards* rather than verdicts. These two histograms are what makes that
 * reviewable — a maintainer adjudicates a couple of dozen rules rather than
 * thousands of sites, which is the same concentration #22 found in ECMA-262
 * and #26 found again in Bikeshed.
 */
function tally(
  proposals: readonly Proposal[],
  select: (site: Proposal["sites"][number]) => string | undefined,
  limit: number,
): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const proposal of proposals) {
    for (const site of proposal.sites) {
      const key = select(site);
      if (key === undefined) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].sort(([, left], [, right]) => right - left).slice(0, limit);
}

function summarize(
  members: readonly DomMember[],
  idlBacked: number,
  withProse: number,
  proposals: readonly Proposal[],
  accessors: ReadonlyMap<string, AccessorRecord>,
  verdicts: readonly DeferredVerdict[],
  byMember: ReadonlyMap<string, BaselineEntry>,
  geckoThrows: number,
  unprobed: number,
  throwBearingExtAttrs: number,
  memberDefinitionsByForm: DfnGraph["stats"]["memberDefinitionsByForm"],
): GenerationReport["summary"] {
  const entries = [...byMember.values()];
  const facts = [...accessors.values()].map((record) => record.fact);
  return {
    members: members.length,
    idlBacked,
    withProse,
    clean: entries.filter(
      (entry) => entry.color === "non-throwing" && (entry.conditions?.length ?? 0) === 0,
    ).length,
    conditional: entries.filter(
      (entry) => entry.color === "non-throwing" && (entry.conditions?.length ?? 0) > 0,
    ).length,
    relaxations: verdicts.filter((verdict) => verdict.adjudication === "queued").length,
    throwing: entries.filter((entry) => entry.color === "throwing").length,
    cleanReads: entries.filter(
      (entry) =>
        entry.accessor !== undefined &&
        entry.accessor !== false &&
        entry.accessor.get === "non-throwing",
    ).length,
    accessorFacts: facts.filter((fact) => fact !== false).length,
    dataNessRecords: facts.filter((fact) => fact === false).length,
    floored: members.length - byMember.size,
    reviewMembers: proposals.filter((proposal) => proposal.reviewSites > 0).length,
    shapes: tally(proposals, (site) => site.shape, 20),
    topRules: tally(
      proposals,
      (site) => (site.verdict === "type-excluded" ? undefined : site.rule.slice(0, 88)),
      12,
    ),
    geckoThrows,
    unprobed,
    throwBearingExtAttrs,
    memberDefinitionsByForm,
  };
}

export function writeBaseline(data: BaselineData): string {
  const path = fileURLToPath(OUTPUT);
  mkdirSync(fileURLToPath(new URL(".", OUTPUT)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, undefined, 2)}\n`);

  writeFileSync(
    recordedSymbolSetPath(),
    `${JSON.stringify(currentSymbolSet(ts), undefined, 2)}\n`,
  );
  return path;
}

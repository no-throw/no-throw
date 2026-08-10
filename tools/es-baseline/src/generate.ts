import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  collectLibMembers,
  createLibProgram,
  TypeDomains,
  type AccessorFact,
  type BaselineData,
  type BaselineEntry,
  type LibMember,
} from "@no-throw/core/baseline";
import ts from "typescript";

import { accessorFactFor } from "./accessors.js";
import { classifyMembers, type Proposal } from "./classify.js";
import { DIALS, type Dials } from "./dials.js";
import { currentSymbolSet, recordedSymbolSetPath } from "./gates/drift.js";
import type { Counterexample } from "./gates/fuzz.js";
import {
  absentPositions,
  runFuzzGate,
  type Claim,
  type GateReport,
} from "./gates/run.js";
import { REFUTED_KEYS } from "./refutations.js";
import { extractSpec } from "./spec/extract.js";
import { loadSpecHtml } from "./spec/source.js";

const OUTPUT = new URL(
  "../../../packages/core/baseline-data/es.json",
  import.meta.url,
);

export interface GenerationReport {
  readonly data: BaselineData;
  /** Counterexamples with no recorded refutation. These fail the build. */
  readonly counterexamples: readonly Counterexample[];
  /** Recorded refutations the gate no longer reproduces — precision left on the table. */
  readonly staleRefutations: readonly string[];
  readonly gate: GateReport;
  readonly summary: {
    readonly members: number;
    readonly joined: number;
    readonly clean: number;
    readonly conditional: number;
    readonly throwing: number;
    /** Accessor facts whose `get` is clean — a property read that is not a call. */
    readonly cleanReads: number;
    /** Members with no entry at all: no color, no accessor fact. */
    readonly floored: number;
    readonly reviewMembers: number;
    /** Unbucketed condition shapes, by rule — the residue, largest first. */
    readonly reviewRules: readonly (readonly [rule: string, count: number])[];
    readonly accessorFacts: number;
    readonly dataNessRecords: number;
    readonly unprobed: number;
    readonly libTargets: number;
  };
}

export function generateBaseline(dials: Dials = DIALS): GenerationReport {
  const corpus = extractSpec(loadSpecHtml());
  const lib = createLibProgram(ts);
  const members = collectLibMembers(lib);
  const domains = new TypeDomains(lib);
  const proposals = classifyMembers(members, corpus, domains, dials);

  const accessors = new Map<string, AccessorFact>();
  for (const member of members) {
    const fact = accessorFactFor(member, corpus, domains, dials);
    if (fact !== undefined) accessors.set(member.key, fact);
  }

  const draft = new Map<string, Claim>();
  const throwing = new Set<string>();
  for (const proposal of proposals) {
    const fact = accessors.get(proposal.member.key);
    draft.set(proposal.member.key, {
      cleanCall: proposal.color === "non-throwing",
      cleanGet: fact !== undefined && fact !== false && fact.get === "non-throwing",
      absent: absentPositions(proposal.conditions),
    });
    if (proposal.color === "throwing") throwing.add(proposal.member.key);
  }

  // Operand tracing is load-bearing, and an unresolved callee is a silent hole
  // in it rather than a member that merely floors.
  if (corpus.stats.unresolvedCallees.length > 0) {
    throw new Error(
      `extraction left ${corpus.stats.unresolvedCallees.length} unresolved callee(s): ${corpus.stats.unresolvedCallees.slice(0, 10).join(", ")}`,
    );
  }

  const gate = runFuzzGate(lib, members, draft, throwing);

  // Unprobed is not refuted — and it is not evidence either, so a clean claim
  // the gate could not reach ships floored rather than clean.
  const unprobedCalls = new Set(
    gate.unprobed.filter((result) => result.probe === "call").map((r) => r.key),
  );
  const unprobedGets = new Set(
    gate.unprobed.filter((result) => result.probe === "get").map((r) => r.key),
  );

  const byMember = new Map<string, BaselineEntry>();
  for (const proposal of proposals) {
    const key = proposal.member.key;
    const fact = gateAccessorFact(accessors.get(key), unprobedGets.has(key));
    const entry = entryFor(
      REFUTED_KEYS.has(key) ? { ...proposal, color: "throwing", conditions: undefined } : proposal,
      fact,
      unprobedCalls.has(key),
    );
    if (entry !== undefined) byMember.set(key, entry);
  }
  for (const member of members) {
    if (byMember.has(member.key)) continue;
    const fact = gateAccessorFact(
      accessors.get(member.key),
      unprobedGets.has(member.key),
    );
    if (fact !== undefined) {
      byMember.set(member.key, { accessor: fact, spec: member.specKey });
    }
  }

  const libs: Record<string, Record<string, BaselineEntry>> = {};
  for (const member of members) {
    const entry = byMember.get(member.key);
    if (entry === undefined) continue;
    for (const target of member.libs) {
      (libs[target] ??= {})[member.key] = entry;
    }
  }

  const data: BaselineData = {
    version: 1,
    unprobed: [...new Set([...unprobedCalls, ...unprobedGets])].sort(),
    libs: sortKeys(libs),
  };

  const refutedThisRun = new Set(gate.counterexamples.map((found) => found.key));
  return {
    data,
    counterexamples: gate.counterexamples.filter(
      (found) => !REFUTED_KEYS.has(found.key),
    ),
    staleRefutations: [...REFUTED_KEYS].filter((key) => !refutedThisRun.has(key)),
    gate,
    summary: summarize(members, proposals, accessors, data, byMember),
  };
}

function entryFor(
  proposal: Proposal,
  accessor: AccessorFact | undefined,
  unprobed: boolean,
): BaselineEntry | undefined {
  const clean = proposal.color === "non-throwing" && !unprobed;
  const color = proposal.color === undefined ? undefined : clean ? "non-throwing" : "throwing";
  // An unprobed clean has no verdict at all — a `throwing` entry would claim
  // knowledge the gate never gave us — so its color is simply absent, and
  // absence floors.
  const shipped = proposal.color === "non-throwing" && unprobed ? undefined : color;
  if (shipped === undefined && accessor === undefined) return undefined;
  return {
    ...(shipped === undefined ? {} : { color: shipped }),
    ...(clean && proposal.conditions !== undefined
      ? { conditions: proposal.conditions }
      : {}),
    ...(accessor === undefined ? {} : { accessor }),
    spec: proposal.member.specKey,
    runtime: proposal.member.runtimePath,
  };
}

/**
 * The gate probes a property *read* and nothing else: there is no probe for a
 * write, because assigning to a shared builtin receiver would corrupt every
 * later probe. So a clean `set` never ships — an unprobed clean claim floors,
 * and that rule does not bend just because no ES setter classifies clean today.
 */
function gateAccessorFact(
  fact: AccessorFact | undefined,
  unprobedGet: boolean,
): AccessorFact | undefined {
  if (fact === undefined || fact === false) return fact;
  return { get: unprobedGet ? "throwing" : fact.get, set: "throwing" };
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function reviewRulesOf(
  proposals: readonly Proposal[],
): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const proposal of proposals) {
    for (const site of proposal.sites) {
      if (site.verdict !== "review") continue;
      const rule = site.rule.slice(0, 80);
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
  }
  return [...counts].sort(([, left], [, right]) => right - left).slice(0, 10);
}

function summarize(
  members: readonly LibMember[],
  proposals: readonly Proposal[],
  accessors: ReadonlyMap<string, AccessorFact>,
  data: BaselineData,
  byMember: ReadonlyMap<string, BaselineEntry>,
): GenerationReport["summary"] {
  const entries = [...byMember.values()];
  return {
    members: members.length,
    joined: proposals.filter((proposal) => proposal.spec !== undefined).length,
    clean: entries.filter(
      (entry) => entry.color === "non-throwing" && (entry.conditions?.length ?? 0) === 0,
    ).length,
    conditional: entries.filter(
      (entry) => entry.color === "non-throwing" && (entry.conditions?.length ?? 0) > 0,
    ).length,
    throwing: entries.filter((entry) => entry.color === "throwing").length,
    cleanReads: [...accessors.values()].filter(
      (fact) => fact !== false && fact.get === "non-throwing",
    ).length,
    floored: members.length - byMember.size,
    reviewMembers: proposals.filter((proposal) => proposal.reviewSites > 0).length,
    reviewRules: reviewRulesOf(proposals),
    accessorFacts: [...accessors.values()].filter((fact) => fact !== false).length,
    dataNessRecords: [...accessors.values()].filter((fact) => fact === false).length,
    unprobed: data.unprobed.length,
    libTargets: Object.keys(data.libs).length,
  };
}

export function writeBaseline(data: BaselineData): string {
  const path = fileURLToPath(OUTPUT);
  mkdirSync(fileURLToPath(new URL(".", OUTPUT)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, undefined, 2)}\n`);

  // The symbol set the data was generated from. The drift gate diffs against
  // it, which is what turns "a new TypeScript release added members" from a
  // thing someone has to notice into a thing CI prints.
  writeFileSync(
    recordedSymbolSetPath(),
    `${JSON.stringify(currentSymbolSet(ts), undefined, 2)}\n`,
  );
  return path;
}

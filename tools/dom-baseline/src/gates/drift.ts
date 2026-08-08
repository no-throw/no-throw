import { readFileSync } from "node:fs";

import { collectDomMembers, createLibProgram } from "@no-throw/core/baseline";
import type ts from "typescript";

import { DOM_LIBS } from "../lib.js";

/**
 * Drift is a symbol-set diff and nothing more. A member TypeScript adds has no
 * entry and therefore floors, so the guarantee holds by construction; the gate
 * exists to *surface* newcomers for classification, not to block on them.
 *
 * `lib.dom.d.ts` has no `lib.esXXXX` rhythm of its own — it is versioned by the
 * TypeScript release, which is the key the ES baseline already diffs against,
 * so #22's mechanism works here unchanged.
 */
export interface SymbolSet {
  readonly typescript: string;
  readonly members: readonly string[];
}

export interface DriftReport {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

const RECORDED = new URL(
  "../../../../packages/core/baseline-data/dom.symbols.json",
  import.meta.url,
);

export function currentSymbolSet(tsApi: typeof ts): SymbolSet {
  const lib = createLibProgram(tsApi, DOM_LIBS);
  return {
    typescript: tsApi.version,
    members: collectDomMembers(lib)
      .members.map((member) => member.key)
      .sort(),
  };
}

export function recordedSymbolSet(): SymbolSet {
  return JSON.parse(readFileSync(RECORDED, "utf8")) as SymbolSet;
}

export function recordedSymbolSetPath(): URL {
  return RECORDED;
}

export function diffSymbols(before: SymbolSet, after: SymbolSet): DriftReport {
  const known = new Set(before.members);
  const now = new Set(after.members);
  return {
    added: after.members.filter((member) => !known.has(member)),
    removed: before.members.filter((member) => !now.has(member)),
  };
}

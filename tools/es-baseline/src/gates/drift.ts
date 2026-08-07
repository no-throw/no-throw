import { readFileSync } from "node:fs";

import { collectLibMembers, createLibProgram } from "@nothrow/core/baseline";
import type ts from "typescript";

/**
 * Drift is a symbol-set diff and nothing more. A member TypeScript adds has no
 * entry and therefore floors, so the guarantee holds by construction; the gate
 * exists to *surface* newcomers for classification, not to block on them.
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
  "../../../../packages/core/baseline-data/es.symbols.json",
  import.meta.url,
);

export function currentSymbolSet(tsApi: typeof ts): SymbolSet {
  const lib = createLibProgram(tsApi);
  return {
    typescript: tsApi.version,
    members: collectLibMembers(lib)
      .map((member) => member.key)
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

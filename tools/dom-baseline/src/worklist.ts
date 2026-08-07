import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Adjudication, DeferredVerdict } from "./gates/deferred.js";

/**
 * The deferred-invocation worklist, committed. #30's Further Notes call this
 * the *terminal* open item of the whole spec, so the adjudication is recorded
 * in the repo rather than living inside one generator run: a reviewer can see
 * every member, its verdict and the evidence for it, and CI can check that the
 * shipped data still says the same thing.
 *
 * Nothing here is ever "needs a human call". Every member is `sync`, `queued`
 * or `unreachable`, and `unreachable` means the member floors.
 */
export interface WorklistEntry {
  readonly key: string;
  readonly param: string;
  readonly adjudication: Adjudication;
  readonly observedAfterCall: boolean;
  readonly evidence: string;
}

export interface Worklist {
  readonly typescript: string;
  readonly engine: string;
  readonly counts: Readonly<Record<Adjudication, number>>;
  readonly entries: readonly WorklistEntry[];
}

const PATH = new URL("../deferred-worklist.json", import.meta.url);

export function worklistPath(): string {
  return fileURLToPath(PATH);
}

export function buildWorklist(
  verdicts: readonly DeferredVerdict[],
  typescript: string,
  engine: string,
): Worklist {
  const entries = verdicts
    .map((verdict) => ({
      key: verdict.key,
      param: verdict.path,
      adjudication: verdict.adjudication,
      observedAfterCall: verdict.observedAfterCall,
      evidence: verdict.evidence,
    }))
    .sort(
      (left, right) =>
        left.key.localeCompare(right.key) || left.param.localeCompare(right.param),
    );

  const counts: Record<Adjudication, number> = { sync: 0, queued: 0, unreachable: 0 };
  for (const entry of entries) counts[entry.adjudication]++;
  return { typescript, engine, counts, entries };
}

export function writeWorklist(worklist: Worklist): string {
  writeFileSync(PATH, `${JSON.stringify(worklist, undefined, 2)}\n`);
  return worklistPath();
}

export function readWorklist(): Worklist {
  return JSON.parse(readFileSync(PATH, "utf8")) as Worklist;
}

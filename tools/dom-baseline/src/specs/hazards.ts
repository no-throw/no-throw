import type { Dfn, DfnGraph, ProseThrow } from "./dfns.js";

/**
 * A member's *whole* hazard set, as a transitive closure over the definition
 * graph. #25 is normative: hand over every root cause, never one witness — one
 * witness can report the cause the declared type discharges and hide the one it
 * does not, which is unsound rather than merely imprecise.
 */
export interface ProseHazard extends ProseThrow {
  /** The definition the throw is written in. */
  readonly at: string;
  readonly atKey: string;
  /** Definition labels from the member down to `at`. */
  readonly via: readonly string[];
  readonly depth: number;
}

export interface MemberProse {
  readonly dfnKey: string;
  readonly hazards: readonly ProseHazard[];
  readonly visited: number;
  /** The hazard budget ran out: read as *more* hazards, never as fewer. */
  readonly truncated: boolean;
}

const MAX_DEPTH = 5;
const MAX_HAZARDS = 60;

/**
 * Rule 1 — **members are leaves**. Only algorithmic definitions carry control
 * flow; a `<dfn>` for an interface, an element name or an attribute is a noun,
 * and propagating through it makes everything reach everything. Prose links
 * `document.domain` to point at it, not to call it, and leaving members in the
 * propagating set made `document.domain` the root cause of 1,676 hazards.
 */
const PROPAGATING_TYPES = new Set(["dfn", "abstract-op"]);

function propagates(node: Dfn | undefined): boolean {
  if (node === undefined) return false;
  if (node.dfnType !== undefined && !PROPAGATING_TYPES.has(node.dfnType)) return false;
  return node.isAlgorithm || node.throws.length > 0 || node.callees.length > 0;
}

interface Reached {
  readonly key: string;
  readonly via: readonly string[];
  /** Which half of an attribute this definition was reached from. */
  readonly phase: "get" | "set" | "both";
}

export function hazardsOf(graph: DfnGraph, rootKey: string): MemberProse | undefined {
  if (!graph.nodes.has(rootKey)) return undefined;

  const seen = new Set<string>([rootKey]);
  const hazards: ProseHazard[] = [];
  let frontier: Reached[] = [{ key: rootKey, via: [], phase: "both" }];
  let depth = 0;
  let visited = 1;
  let truncated = false;

  while (frontier.length > 0 && depth <= MAX_DEPTH) {
    const next: Reached[] = [];
    for (const { key, via, phase } of frontier) {
      const node = graph.nodes.get(key);
      if (node === undefined) continue;
      for (const thrown of node.throws) {
        if (hazards.length >= MAX_HAZARDS) {
          truncated = true;
          break;
        }
        hazards.push({
          ...thrown,
          phase: narrow(phase, thrown.phase),
          at: node.label,
          atKey: node.key,
          via,
          depth,
        });
      }
      if (truncated) break;
      for (const callee of node.callees) {
        if (seen.has(callee.key)) continue;
        const target = graph.nodes.get(callee.key);
        if (!propagates(target)) continue;
        seen.add(callee.key);
        visited++;
        next.push({
          key: callee.key,
          via: [...via, target?.label ?? callee.key],
          phase: narrow(phase, callee.phase),
        });
      }
    }
    if (truncated) break;
    frontier = next;
    depth++;
  }

  return { dfnKey: rootKey, hazards, visited, truncated };
}

/**
 * A hazard belongs to the getter only if *every* step on the way to it did.
 * `both` on either side widens, which is the over-approximating direction.
 */
function narrow(
  outer: "get" | "set" | "both",
  inner: "get" | "set" | "both",
): "get" | "set" | "both" {
  if (outer === "both") return inner;
  if (inner === "both") return outer;
  return outer === inner ? outer : "both";
}

/**
 * `Interface.member` → the definition that describes it, keyed off Bikeshed's
 * own `data-dfn-for` and `data-lt`. A real algorithm beats a bare IDL
 * restatement of the same name.
 */
export function memberDfnIndex(graph: DfnGraph): ReadonlyMap<string, Dfn> {
  const index = new Map<string, Dfn>();
  for (const node of graph.nodes.values()) {
    if (!["method", "attribute", "constructor"].includes(node.dfnType ?? "")) continue;
    const names = new Set<string>();
    for (const alternate of node.lt) {
      const bare = alternate.replace(/\(.*$/, "").trim();
      if (bare !== "") names.add(bare);
    }
    // `dom-element-matches` → `matches`, for definitions with no `data-lt`.
    const fromId = node.id.replace(/^dom-/, "").split("-").pop();
    if (fromId !== undefined && fromId !== "") names.add(fromId);
    if (node.dfnType === "constructor") names.add("constructor");

    for (const owner of node.dfnFor) {
      for (const name of names) {
        const key = `${owner}.${name}`.toLowerCase();
        const existing = index.get(key);
        if (existing === undefined || (node.isAlgorithm && !existing.isAlgorithm)) {
          index.set(key, node);
        }
      }
    }
  }
  return index;
}

import type { Bodied } from "./declarations.js";

/**
 * What the fixpoint needs to know about one body, with the graph already cut at
 * the pinned nodes — marked seeds, resolver hits, bodyless floors — which do
 * not participate.
 */
export interface BodyEdges {
  /** An unbridged `throw`, or an unbridged call to something pinned throwing. */
  readonly throws: boolean;
  /** Unbridged transfers into bodies whose color has to be inferred. */
  readonly callees: readonly Bodied[];
}

/**
 * A cycle group and the one color its members share. The memo unit is the
 * group, not the function: a cycle resolves and commits as a whole, so
 * whatever later invalidates one member has to dirty all of them, and an edit
 * can split or merge groups.
 */
interface Group {
  readonly members: ReadonlySet<Bodied>;
  readonly throwing: boolean;
}

/** Tarjan's per-node bookkeeping. `lowlink` is the only thing that moves. */
interface Visit {
  readonly index: number;
  lowlink: number;
}

export interface Fixpoint {
  /** Whether `body` is throwing, resolving its group first if it has no color. */
  isThrowing(body: Bodied): boolean;
}

/**
 * The optimistic least fixpoint over the unbridged-call graph, computed
 * group-then-resolve by Tarjan SCC condensation. Recursion alone is not
 * throwing — a function is throwing iff some *finite* path reaches an unbridged
 * throw site, and a cycle contributes paths, not throw sites — so the least
 * fixpoint is the precise answer rather than a charitable one.
 *
 * The normative invariant is that no member of an unresolved cycle may be
 * assigned a color. That is what the condensation buys and what a memoized
 * optimistic DFS gets wrong: it answers a back-edge provisionally, commits that
 * guess, and never revisits it once the cycle turns out to reach a throw.
 *
 * The graph is walked lazily from whatever is asked about, so only the
 * reachable unmarked subgraph is ever built.
 */
export function createFixpoint(edgesOf: (body: Bodied) => BodyEdges): Fixpoint {
  const edges = new Map<Bodied, BodyEdges>();
  const groups = new Map<Bodied, Group>();
  const visits = new Map<Bodied, Visit>();
  const stack: Bodied[] = [];
  const onStack = new Set<Bodied>();
  let nextIndex = 0;

  const edgesFor = (body: Bodied): BodyEdges => {
    const known = edges.get(body);
    if (known !== undefined) return known;
    const read = edgesOf(body);
    edges.set(body, read);
    return read;
  };

  const visit = (body: Bodied): Visit => {
    const state: Visit = { index: nextIndex, lowlink: nextIndex };
    nextIndex += 1;
    visits.set(body, state);
    stack.push(body);
    onStack.add(body);

    for (const callee of edgesFor(body).callees) {
      const seen = visits.get(callee);
      if (seen === undefined) {
        state.lowlink = Math.min(state.lowlink, visit(callee).lowlink);
      } else if (onStack.has(callee)) {
        state.lowlink = Math.min(state.lowlink, seen.index);
      }
    }

    if (state.lowlink === state.index) commit(unstack(body));
    return state;
  };

  /** The group a root closes: itself and everything pushed after it. */
  const unstack = (root: Bodied): ReadonlySet<Bodied> => {
    const members = new Set<Bodied>();
    for (;;) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      members.add(member);
      if (member === root) break;
    }
    return members;
  };

  const commit = (members: ReadonlySet<Bodied>): void => {
    // Calls that stay inside the group are ignored: they are the paths a cycle
    // contributes. Anything outside it has already committed — Tarjan closes
    // groups in reverse topological order — and anything that somehow has not
    // reads as throwing, which is the safe direction.
    const throwing = [...members].some((member) => {
      const { throws, callees } = edgesFor(member);
      return (
        throws ||
        callees.some(
          (callee) =>
            !members.has(callee) && groups.get(callee)?.throwing !== false,
        )
      );
    });

    const group: Group = { members, throwing };
    for (const member of members) groups.set(member, group);
  };

  return {
    isThrowing(body) {
      const known = groups.get(body);
      if (known !== undefined) return known.throwing;
      visit(body);
      // A completed walk always closes the group it started from. If that ever
      // stops holding, an uncolored body is a throwing one.
      return groups.get(body)?.throwing ?? true;
    },
  };
}

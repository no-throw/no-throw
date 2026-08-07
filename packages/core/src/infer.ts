import type ts from "typescript";

/** A node of the call graph: an unpinned function, so always one with a body. */
type Fn = ts.SignatureDeclaration;

/**
 * What the fixpoint needs to know about one body, with the graph already cut at
 * the pinned nodes — marked seeds, resolver hits, bodyless floors — which do
 * not participate.
 */
export interface BodyEdges {
  /** An unbridged `throw`, or an unbridged call to something pinned throwing. */
  readonly throws: boolean;
  /** Unbridged calls to functions whose color has to be inferred. */
  readonly callees: readonly Fn[];
}

/**
 * A cycle group and the one color its members share. The memo unit is the
 * group, not the function: a cycle resolves and commits as a whole, so
 * whatever later invalidates one member has to dirty all of them, and an edit
 * can split or merge groups.
 */
interface Group {
  readonly members: ReadonlySet<Fn>;
  readonly throwing: boolean;
}

/** Tarjan's per-node bookkeeping. `lowlink` is the only thing that moves. */
interface Visit {
  readonly index: number;
  lowlink: number;
}

export interface Fixpoint {
  /** Whether `fn` is throwing, resolving its group first if it has no color. */
  isThrowing(fn: Fn): boolean;
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
export function createFixpoint(edgesOf: (fn: Fn) => BodyEdges): Fixpoint {
  const edges = new Map<Fn, BodyEdges>();
  const groups = new Map<Fn, Group>();
  const visits = new Map<Fn, Visit>();
  const stack: Fn[] = [];
  const onStack = new Set<Fn>();
  let nextIndex = 0;

  const edgesFor = (fn: Fn): BodyEdges => {
    const known = edges.get(fn);
    if (known !== undefined) return known;
    const read = edgesOf(fn);
    edges.set(fn, read);
    return read;
  };

  const visit = (fn: Fn): Visit => {
    const state: Visit = { index: nextIndex, lowlink: nextIndex };
    nextIndex += 1;
    visits.set(fn, state);
    stack.push(fn);
    onStack.add(fn);

    for (const callee of edgesFor(fn).callees) {
      const seen = visits.get(callee);
      if (seen === undefined) {
        state.lowlink = Math.min(state.lowlink, visit(callee).lowlink);
      } else if (onStack.has(callee)) {
        state.lowlink = Math.min(state.lowlink, seen.index);
      }
    }

    if (state.lowlink === state.index) commit(unstack(fn));
    return state;
  };

  /** The group a root closes: itself and everything pushed after it. */
  const unstack = (root: Fn): ReadonlySet<Fn> => {
    const members = new Set<Fn>();
    for (;;) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      members.add(member);
      if (member === root) break;
    }
    return members;
  };

  const commit = (members: ReadonlySet<Fn>): void => {
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
    isThrowing(fn) {
      const known = groups.get(fn);
      if (known !== undefined) return known.throwing;
      visit(fn);
      // A completed walk always closes the group it started from. If that ever
      // stops holding, an uncolored function is a throwing one.
      return groups.get(fn)?.throwing ?? true;
    },
  };
}

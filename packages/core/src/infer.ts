import type { Bodied } from "./declarations.js";

/**
 * One dimension of the color lattice — `throwing`, or the condition set —
 * stated as what the fixpoint needs to resolve it. `bottom` is the optimistic
 * value a cycle starts from, and `recompute` has to be monotone in what it
 * reads, which is what makes the iteration converge.
 *
 * The lattice is richer than a boolean, and this is where that lands: one
 * machine, asked twice, rather than a second algorithm for conditions.
 */
export interface Dimension<T> {
  readonly bottom: T;
  /**
   * What a node whose group somehow did not close reads as. `bottom` is the
   * optimistic start and is not safe to leak, so this is the sound direction
   * instead: it should never be reachable, and if it is, it fails strict.
   */
  readonly unresolved: T;
  /**
   * Every node `recompute` may read the value of. Missing one lets a group
   * close before something it depends on has, so it is a soundness bug rather
   * than a slow path.
   */
  dependenciesOf(body: Bodied): readonly Bodied[];
  recompute(body: Bodied, valueOf: (body: Bodied) => T): T;
  /** Whether two successive values are the same, so the iteration can stop. */
  settled(a: T, b: T): boolean;
}

export interface Fixpoint<T> {
  /** `body`'s value, resolving its group first if it has none. */
  valueOf(body: Bodied): T;
}

/**
 * The optimistic least fixpoint over the unbridged-call graph, computed
 * group-then-resolve by Tarjan SCC condensation. Recursion alone is not
 * throwing — a function is throwing iff some *finite* path reaches an unbridged
 * throw site, and a cycle contributes paths, not throw sites — so the least
 * fixpoint is the precise answer rather than a charitable one, and the same
 * holds of the conditions a cycle passes around itself.
 *
 * The normative invariant is that no member of an unresolved cycle may be
 * assigned a color. That is what the condensation buys and what a memoized
 * optimistic DFS gets wrong: it answers a back-edge provisionally, commits that
 * guess, and never revisits it once the cycle turns out to reach a throw.
 *
 * The graph is walked lazily from whatever is asked about, so only the
 * reachable unmarked subgraph is ever built.
 */
export function createFixpoint<T>(dimension: Dimension<T>): Fixpoint<T> {
  const committed = new Map<Bodied, T>();
  const provisional = new Map<Bodied, T>();
  const visits = new Map<Bodied, Visit>();
  const stack: Bodied[] = [];
  const onStack = new Set<Bodied>();
  let nextIndex = 0;

  /**
   * What `recompute` reads. Everything outside the group being resolved has
   * committed — Tarjan closes groups in reverse topological order — so the only
   * provisional values are the group's own.
   */
  const current = (body: Bodied): T =>
    committed.get(body) ?? provisional.get(body) ?? dimension.bottom;

  const visit = (body: Bodied): Visit => {
    const state: Visit = { index: nextIndex, lowlink: nextIndex };
    nextIndex += 1;
    visits.set(body, state);
    stack.push(body);
    onStack.add(body);

    for (const dependency of dimension.dependenciesOf(body)) {
      const seen = visits.get(dependency);
      if (seen === undefined) {
        state.lowlink = Math.min(state.lowlink, visit(dependency).lowlink);
      } else if (onStack.has(dependency)) {
        state.lowlink = Math.min(state.lowlink, seen.index);
      }
    }

    if (state.lowlink === state.index) resolve(unstack(body));
    return state;
  };

  /** The group a root closes: itself and everything pushed after it. */
  const unstack = (root: Bodied): readonly Bodied[] => {
    const members: Bodied[] = [];
    for (;;) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      members.push(member);
      if (member === root) break;
    }
    return members;
  };

  /**
   * Iterate the group from `bottom` until nothing moves, then commit all of it
   * at once. A group of one settles in a single pass; a cycle takes as many as
   * its members need to agree.
   */
  const resolve = (members: readonly Bodied[]): void => {
    for (const member of members) provisional.set(member, dimension.bottom);

    for (let moving = true; moving; ) {
      moving = false;
      for (const member of members) {
        const next = dimension.recompute(member, current);
        if (dimension.settled(next, current(member))) continue;
        provisional.set(member, next);
        moving = true;
      }
    }

    for (const member of members) {
      committed.set(member, current(member));
      provisional.delete(member);
    }
  };

  return {
    valueOf(body) {
      const known = committed.get(body);
      if (known !== undefined) return known;
      visit(body);
      // A completed walk always closes the group it started from. If that ever
      // stops holding, the answer is the sound one rather than the optimistic
      // start the iteration happens to be sitting on.
      return committed.get(body) ?? dimension.unresolved;
    },
  };
}

/** Tarjan's per-node bookkeeping. `lowlink` is the only thing that moves. */
interface Visit {
  readonly index: number;
  lowlink: number;
}

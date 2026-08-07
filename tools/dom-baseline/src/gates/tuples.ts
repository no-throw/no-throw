/**
 * One tuple per candidate value, varied a position at a time against a baseline
 * of first choices. The full cross product is unaffordable and buys little:
 * almost every DOM guard is about one argument.
 *
 * Only the shape is shared. What goes *into* the pools is the opposite in the
 * two callers — the fuzz gate leads with degenerate values because those refute,
 * the deferred probe leads with ordinary ones because a throwing argument stops
 * the member from ever reaching its callback — and that difference is the point
 * of each, not an accident to be unified away.
 */
export function varyOnePosition(
  pools: readonly (readonly unknown[])[],
  options: { readonly fixed?: number; readonly includeEmpty?: boolean } = {},
): readonly (readonly unknown[])[] {
  const baseline = pools.map((pool) => pool[0]);
  const tuples: (readonly unknown[])[] = [baseline];
  pools.forEach((pool, index) => {
    if (index === options.fixed) return;
    for (const value of pool.slice(1)) {
      const tuple = [...baseline];
      tuple[index] = value;
      tuples.push(tuple);
    }
  });
  if (options.includeEmpty === true) tuples.push([]);
  return tuples;
}

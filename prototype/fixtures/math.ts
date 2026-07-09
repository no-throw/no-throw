// math.ts — shared callees used across files, in three colors.

/** @nothrow */
export function add(a: number, b: number): number {
  return a + b; // marked seed, clean → non-throwing (declared)
}

// unmarked, but body is provably clean → the engine should INFER non-throwing (#4 hybrid)
export function double(n: number): number {
  return n * 2;
}

// unmarked, contains a bare throw → the engine should infer THROWING
export function mustBePositive(n: number): number {
  if (n < 0) throw new Error('negative');
  return n;
}

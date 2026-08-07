function* counter(): Generator<number> {
  yield 1;
}

/** @nothrow */
export function direct(): Generator<number> {
  return counter();
}

/** @nothrow */
export function viaConst(): Generator<number> {
  const it = counter();
  return it;
}

/** @nothrow */
export function total(): number {
  let sum = 0;
  for (const value of direct()) sum += value;
  for (const value of viaConst()) sum += value;
  return sum;
}

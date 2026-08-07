/** @nothrow */
function* counter(): Generator<number> {
  yield 1;
}

/** @nothrow */
export function fromParameter(source: Generator<number>): number {
  let sum = 0;
  for (const value of source) sum += value;
  return sum;
}

/** @nothrow */
export function fromReassignable(): number {
  let it = counter();
  let sum = 0;
  for (const value of it) sum += value;
  return sum;
}

/** @nothrow */
export function* counter(): Generator<number> {
  yield 1;
  yield 2;
}

/** @nothrow */
export function total(): number {
  let sum = 0;
  for (const value of counter()) sum += value;
  return sum;
}

/** @nothrow */
export function collected(): number[] {
  return [...counter()];
}

/** @nothrow */
export function first(): number | undefined {
  const it = counter();
  const [head] = it;
  it.return(0);
  return head;
}

/** @nothrow */
export function stepped(): number | undefined {
  const it = counter();
  return it.next().value;
}

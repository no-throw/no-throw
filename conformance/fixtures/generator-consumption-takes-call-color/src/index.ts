function* broken(): Generator<number> {
  throw "boom";
}

/** @nothrow */
export function total(): number {
  let sum = 0;
  for (const value of broken()) sum += value;
  return sum;
}

/** @nothrow */
export function collected(): number[] {
  return [...broken()];
}

/** @nothrow */
export function first(): number | undefined {
  const [head] = broken();
  return head;
}

/** @nothrow */
export function stepped(): void {
  const it = broken();
  it.next();
}

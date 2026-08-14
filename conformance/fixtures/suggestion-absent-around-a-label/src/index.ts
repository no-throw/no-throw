function* broken(): Generator<number> {
  throw "boom";
}

declare function risky(value: number): void;

/** @nothrow */
export function total(): number {
  let sum = 0;
  outer: for (const value of broken()) {
    if (value < 0) continue outer;
    sum += value;
  }
  return sum;
}

/** @nothrow */
export function once(value: number): void {
  step: risky(value);
}

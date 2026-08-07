class Countdown {
  private n = 3;

  [Symbol.iterator](): Countdown {
    return this;
  }

  next(): IteratorResult<number> {
    if (this.n === 0) return { value: undefined, done: true };
    this.n -= 1;
    return { value: this.n, done: false };
  }
}

/** @nothrow */
export function total(): number {
  let sum = 0;
  for (const value of new Countdown()) sum += value;
  return sum;
}

/** @nothrow */
export function collected(): number[] {
  return [...new Countdown()];
}

/** @nothrow */
export function first(): number | undefined {
  const [head] = new Countdown();
  return head;
}

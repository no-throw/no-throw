class Clean {
  [Symbol.iterator](): Clean {
    return this;
  }

  next(): IteratorResult<number> {
    return { value: undefined, done: true };
  }
}

class Broken {
  [Symbol.iterator](): Broken {
    return this;
  }

  next(): IteratorResult<number> {
    throw "boom";
  }
}

/** @nothrow */
export function total(source: Clean | Broken): number {
  let sum = 0;
  for (const value of source) sum += value;
  return sum;
}

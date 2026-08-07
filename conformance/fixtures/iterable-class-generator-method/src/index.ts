class Broken {
  *[Symbol.iterator](): Generator<number> {
    throw "boom";
  }
}

class Clean {
  *[Symbol.iterator](): Generator<number> {
    yield 1;
  }
}

/** @nothrow */
export function fromBroken(): number {
  let sum = 0;
  for (const value of new Broken()) sum += value;
  return sum;
}

/** @nothrow */
export function fromClean(): number {
  let sum = 0;
  for (const value of new Clean()) sum += value;
  return sum;
}

class Clean {
  *[Symbol.iterator](): Generator<number> {
    yield 1;
  }
}

class Broken {
  *[Symbol.iterator](): Generator<number> {
    throw new Error("boom");
  }
}

/** @nothrow */
export function consumesBinding(): number {
  let source: Clean | Broken = new Clean();
  const replace = (): void => {
    source = new Broken();
  };
  if (!(source instanceof Clean)) return 0;
  replace();
  let sum = 0;
  for (const value of source) sum += value;
  return sum;
}

/** @nothrow */
export function consumesConstant(source: Clean | Broken): number {
  const held = source;
  if (!(held instanceof Clean)) return 0;
  let sum = 0;
  for (const value of held) sum += value;
  return sum;
}

async function* rejects(): AsyncGenerator<number> {
  throw "boom";
}

/** @nothrow */
async function* resolves(): AsyncGenerator<number> {
  yield 1;
}

/** @nothrow */
export async function consumesThrowing(): Promise<number> {
  let sum = 0;
  for await (const value of rejects()) sum += value;
  return sum;
}

/** @nothrow */
export async function consumesClean(): Promise<number> {
  let sum = 0;
  for await (const value of resolves()) sum += value;
  return sum;
}

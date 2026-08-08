function boom(): number {
  throw "boom";
}

async function* lazyBodyEagerParameters(
  seed: number = boom(),
): AsyncGenerator<number> {
  yield seed;
}

async function plainAsync(seed: number = boom()): Promise<number> {
  return seed;
}

/** @nothrow */
function keep(_value: unknown): void {}

/** @nothrow */
export function callsAsyncGenerator(): void {
  keep(lazyBodyEagerParameters());
}

/** @nothrow */
export function callsAsyncFunction(): void {
  keep(plainAsync());
}

/** @nothrow */
export async function awaitsAsyncFunction(): Promise<number> {
  return await plainAsync();
}

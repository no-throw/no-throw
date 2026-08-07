/** @nothrow */
export function myEach<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (let i = 0; i < xs.length; i += 1) cb(xs[i]);
}

export function make(handler: (t: string) => void): () => void {
  /** @nothrow */
  const run = (): void => {
    myEach(inputs, handler);
  };
  return run;
}

const inputs: readonly string[] = [];

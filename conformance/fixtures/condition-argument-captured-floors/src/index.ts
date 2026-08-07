/** @nothrow */
export function myEach<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (const x of xs) cb(x);
}

export function make(handler: (t: string) => void): () => void {
  /** @nothrow */
  const run = (): void => {
    myEach(inputs, handler);
  };
  return run;
}

const inputs: readonly string[] = [];

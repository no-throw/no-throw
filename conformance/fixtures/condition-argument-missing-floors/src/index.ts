/** @nothrow */
export function myEach<T>(xs: readonly T[], cb?: (t: T) => void): void {
  for (const x of xs) cb?.(x);
}

/** @nothrow */
export function run(inputs: readonly string[]): void {
  myEach(inputs);
}

export function makeEach<T>(cb: (t: T) => void): (xs: readonly T[]) => void {
  /** @nothrow */
  const each = (xs: readonly T[]): void => {
    for (const x of xs) cb(x);
  };
  return each;
}

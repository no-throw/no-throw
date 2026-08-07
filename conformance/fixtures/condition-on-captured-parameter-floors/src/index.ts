export function makeEach<T>(cb: (t: T) => void): (xs: readonly T[]) => void {
  /** @nothrow */
  const each = (xs: readonly T[]): void => {
    for (let i = 0; i < xs.length; i += 1) cb(xs[i]);
  };
  return each;
}

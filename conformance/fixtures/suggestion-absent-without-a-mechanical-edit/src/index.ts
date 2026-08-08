declare function risky(): number;

/** @nothrow */
export const compute = (): number => risky();

/** @nothrow */
export function store(): number {
  const value = risky();
  return value;
}

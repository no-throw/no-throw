declare function g(): void;

/** @nothrow */
export const f = g;

/** @nothrow */
export default g;

export function attempt(): number {
  /** @nothrow */
  const total = 1 + 1;
  return total;
}

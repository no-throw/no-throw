declare function risky(): void;
declare function count(): number;

/** @nothrow */
export function usesRisky(): void {
  risky();
}

/** @nothrow */
export function countsRisky(): number {
  return count();
}

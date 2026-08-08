declare function risky(): void;

/** @nothrow */
export function usesRisky(): void {
  risky();
}

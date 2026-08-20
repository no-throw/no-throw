interface Math {
  max(...values: number[]): number;
}

declare const mine: Math;

/** @nothrow */
export function larger(a: number, b: number): number {
  return mine.max(a, b);
}

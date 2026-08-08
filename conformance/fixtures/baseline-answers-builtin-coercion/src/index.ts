interface Point {
  readonly x: number;
  readonly y: number;
}

/** @nothrow */
export function describe(point: Point): string {
  return `${point}`;
}

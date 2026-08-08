export function attempt(): number {
  /** @nothrow */
  const total = 1 + 1;
  return total;
}

/** @nothrow */
export function fail(): void {
  throw "boom";
}

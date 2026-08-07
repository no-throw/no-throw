declare function fetchFlaky(): Promise<number>;

/** @nothrow */
export function discardsBodyless(): void {
  fetchFlaky();
}

/** @nothrow */
export function discardsAParameter(pending: Promise<number>): void {
  void pending;
}

/** @nothrow */
export function handsOnAParameter(
  pending: Promise<number>,
): Promise<number> {
  return pending;
}

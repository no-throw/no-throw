declare function fetchFlaky(): Promise<number>;

/** @nothrow */
export function discardsBodyless(): void {
  fetchFlaky();
}

/** @nothrow */
export function handsOnAParameter(
  pending: Promise<number>,
): Promise<number> {
  return pending;
}

async function rejects(): Promise<void> {
  throw "boom";
}

/** @nothrow */
async function resolves(): Promise<void> {}

/** @nothrow */
export function discardsThrowing(): void {
  rejects();
}

/** @nothrow */
export function voidsThrowing(): void {
  void rejects();
}

/** @nothrow */
export function discardsClean(): void {
  resolves();
}

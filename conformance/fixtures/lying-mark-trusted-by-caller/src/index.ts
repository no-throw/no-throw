/** @nothrow */
export function lies(): void {
  throw new Error("boom");
}

/** @nothrow */
export function trusts(): void {
  lies();
}

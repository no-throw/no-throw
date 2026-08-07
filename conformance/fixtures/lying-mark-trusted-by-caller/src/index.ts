/** @nothrow */
export function lies(): void {
  throw "boom";
}

/** @nothrow */
export function trusts(): void {
  lies();
}

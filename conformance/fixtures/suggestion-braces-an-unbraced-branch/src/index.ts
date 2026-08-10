declare function risky(value: string): void;

/** @nothrow */
export function whenAsked(value: string, wanted: boolean): void {
  if (wanted) risky(value);
}

/** @nothrow */
export function otherwise(value: string, done: boolean): void {
  if (done) return;
  else risky(value);
}

/** @nothrow */
export function onItsOwnLine(value: string, wanted: boolean): void {
  if (wanted)
    risky(value);
}

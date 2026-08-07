/** @nothrow */
export function callIt(f: () => void): void {
  f();
}

/** @nothrow */
export function runAll(
  fs: readonly (() => void)[],
  cb: (f: () => void) => void,
): void {
  for (const f of fs) cb(f);
}

/** @nothrow */
export function go(fs: readonly (() => void)[]): void {
  runAll(fs, callIt);
}

/** @nothrow */
export function callIt(f: () => void): void {
  f();
}

/** @nothrow */
export function runAll(
  fs: readonly (() => void)[],
  cb: (f: () => void) => void,
): void {
  for (let i = 0; i < fs.length; i += 1) cb(fs[i]);
}

/** @nothrow */
export function go(fs: readonly (() => void)[]): void {
  runAll(fs, callIt);
}

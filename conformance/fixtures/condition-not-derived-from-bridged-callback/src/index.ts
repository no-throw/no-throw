/** @nothrow */
export function forEachSafely<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (let i = 0; i < xs.length; i += 1) {
    try {
      cb(xs[i]);
    } catch {
      failures += 1;
    }
  }
}

/** @nothrow */
export function run(inputs: readonly string[]): void {
  forEachSafely(inputs, risky);
}

function risky(text: string): void {
  JSON.parse(text);
}

let failures = 0;

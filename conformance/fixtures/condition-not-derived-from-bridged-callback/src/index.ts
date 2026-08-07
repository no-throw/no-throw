/** @nothrow */
export function forEachSafely<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (const x of xs) {
    try {
      cb(x);
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

function eachOf<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (const x of xs) cb(x);
}

/** @nothrow */
export function record(inputs: readonly string[]): void {
  eachOf(inputs, (text) => {
    seen[seen.length] = text;
  });
}

/** @nothrow */
export function parse(inputs: readonly string[]): void {
  eachOf(inputs, (text) => {
    parsed[parsed.length] = JSON.parse(text);
  });
}

const seen: string[] = [];
const parsed: unknown[] = [];

function eachOf<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (let i = 0; i < xs.length; i += 1) cb(xs[i]);
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

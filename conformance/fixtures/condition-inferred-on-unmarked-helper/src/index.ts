function eachOf<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (let i = 0; i < xs.length; i += 1) cb(xs[i]);
}

/** @nothrow */
export function record(inputs: readonly string[]): void {
  eachOf(inputs, (text) => {
    seen.last = text;
  });
}

/** @nothrow */
export function parse(inputs: readonly string[]): void {
  eachOf(inputs, (text) => {
    parsed.last = JSON.parse(text);
  });
}

const seen = { last: "" };
const parsed: { last: unknown } = { last: undefined };

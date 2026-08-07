/** @nothrow */
export function myEach<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (let i = 0; i < xs.length; i += 1) cb(xs[i]);
}

/** @nothrow */
export function run(inputs: readonly string[]): void {
  const cb = record;
  myEach(inputs, cb);
}

function record(text: string): void {
  seen[seen.length] = text;
}

const seen: string[] = [];

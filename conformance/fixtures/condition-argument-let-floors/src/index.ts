/** @nothrow */
export function myEach<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (const x of xs) cb(x);
}

/** @nothrow */
export function run(inputs: readonly string[], verbose: boolean): void {
  let cb = record;
  if (verbose) cb = record;
  myEach(inputs, cb);
}

function record(text: string): void {
  seen[seen.length] = text;
}

const seen: string[] = [];

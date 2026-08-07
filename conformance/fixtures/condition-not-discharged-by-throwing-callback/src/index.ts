interface User {
  readonly raw: string;
}

/** @nothrow */
export function myEach<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (let i = 0; i < xs.length; i += 1) cb(xs[i]);
}

/** @nothrow */
export function parseAll(users: readonly User[]): void {
  myEach(users, (u) => {
    parsed[parsed.length] = JSON.parse(u.raw);
  });
}

const parsed: unknown[] = [];

interface User {
  readonly raw: string;
}

/** @nothrow */
export function myEach<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (const x of xs) cb(x);
}

/** @nothrow */
export function parseAll(users: readonly User[]): void {
  myEach(users, (u) => {
    parsed[parsed.length] = JSON.parse(u.raw);
  });
}

const parsed: unknown[] = [];

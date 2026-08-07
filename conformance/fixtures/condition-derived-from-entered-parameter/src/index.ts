interface User {
  readonly name: string;
}

/** @nothrow */
export function myEach<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (const x of xs) cb(x);
}

/** @nothrow */
export function collect(users: readonly User[]): void {
  myEach(users, (u) => {
    seen[seen.length] = u.name;
  });
}

const seen: string[] = [];

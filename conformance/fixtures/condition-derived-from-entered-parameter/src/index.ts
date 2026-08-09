interface User {
  readonly name: string;
}

/** @nothrow */
export function myEach<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (let i = 0; i < xs.length; i += 1) cb(xs[i]);
}

/** @nothrow */
export function collect(users: readonly User[]): void {
  myEach(users, (u) => {
    seen.last = u.name;
  });
}

const seen = { last: "" };

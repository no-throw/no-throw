interface User {
  readonly name: string;
}

/** @nothrow */
export function myMapKeys<T>(xs: readonly T[], key: (t: T) => string): string[] {
  return myMap(xs, key);
}

function myMap<T, U>(xs: readonly T[], f: (t: T) => U): U[] {
  const out: U[] = [];
  for (const x of xs) out[out.length] = f(x);
  return out;
}

/** @nothrow */
export function names(users: readonly User[]): string[] {
  return myMapKeys(users, (u) => u.name);
}

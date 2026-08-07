interface User {
  readonly name: string;
}

/** @nothrow */
export function myMapKeys<T>(xs: readonly T[], key: (t: T) => string): string[] {
  return myMap(xs, key);
}

function myMap<T, U>(xs: readonly T[], f: (t: T) => U): U[] {
  const out: U[] = [];
  for (let i = 0; i < xs.length; i += 1) out[out.length] = f(xs[i]);
  return out;
}

/** @nothrow */
export function names(users: readonly User[]): string[] {
  return myMapKeys(users, (u) => u.name);
}

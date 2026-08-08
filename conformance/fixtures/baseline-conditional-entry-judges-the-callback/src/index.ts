interface User {
  readonly name: string;
  readonly raw: string;
}

/** @nothrow */
export function collect(users: readonly User[]): void {
  users.forEach((u) => {
    sink.last = u.name;
  });
}

/** @nothrow */
export function parse(users: readonly User[]): void {
  users.forEach((u) => {
    sink.parsed = JSON.parse(u.raw);
  });
}

const sink: { last: string; parsed: unknown } = { last: "", parsed: undefined };

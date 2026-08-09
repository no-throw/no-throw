interface User {
  readonly name: string;
}

declare const record: (u: User) => void;

/** @nothrow */
export function collect(users: readonly User[]): void {
  users.forEach(record);
}

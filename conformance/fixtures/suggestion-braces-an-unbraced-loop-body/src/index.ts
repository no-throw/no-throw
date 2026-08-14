declare function risky(value: string): void;

/** @nothrow */
export function eachOf(values: readonly string[]): void {
  for (const value of values) risky(value);
}

/** @nothrow */
export function eachKeyOf(values: Record<string, string>): void {
  for (const key in values) risky(key);
}

/** @nothrow */
export function counted(value: string): void {
  for (let index = 0; index < 3; index += 1) risky(value);
}

/** @nothrow */
export function whileOpen(value: string, open: boolean): void {
  while (open) risky(value);
}

/** @nothrow */
export function atLeastOnce(value: string, open: boolean): void {
  do risky(value);
  while (open);
}

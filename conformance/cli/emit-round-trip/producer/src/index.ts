/** @nothrow */
export function twice(n: number): number {
  return n * 2;
}

/** @nothrow */
export async function fetchOk(): Promise<number> {
  return 1;
}

/** @nothrow */
export function each<T>(items: T[], visit: (item: T) => void): void {
  for (let index = 0; index < items.length; index += 1) {
    visit(items[index]);
  }
}

export function widen(value: string): string;
export function widen(value: number): string;
/** @nothrow */
export function widen(value: string | number): string {
  return `${value}`;
}

let latest: (() => void) | undefined;

/** @nothrow */
export function register(handler: () => void): void {
  latest = handler;
}

export function latestHandler(): (() => void) | undefined {
  return latest;
}

/** @nothrow */
export function isFlag(text: string): boolean {
  return text.startsWith("--");
}

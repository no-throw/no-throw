declare const text: string;
declare const count: number;
declare const flag: boolean;
declare const missing: string | null;

/** @nothrow */
export function interpolate(): string {
  return `${text} ${count} ${flag} ${missing}`;
}

/** @nothrow */
export function arithmetic(): number {
  return count + 1;
}

/** @nothrow */
export function negate(): number {
  return -count;
}

/** @nothrow */
export function compare(): boolean {
  return count == 1;
}

/** @nothrow */
export function label<K extends string>(key: K): string {
  return `${key}`;
}

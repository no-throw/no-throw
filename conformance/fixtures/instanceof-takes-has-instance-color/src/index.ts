class Ordinary {}

class Custom {
  static [Symbol.hasInstance](value: unknown): boolean {
    throw new Error("no");
  }
}

declare const value: object;

/** @nothrow */
export function ordinary(): boolean {
  return value instanceof Ordinary;
}

/** @nothrow */
export function custom(): boolean {
  return value instanceof Custom;
}

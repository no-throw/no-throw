class ThrowingToString {
  [Symbol.toPrimitive](hint: string): string {
    return hint;
  }

  valueOf(): number {
    return 1;
  }

  toString(): string {
    throw new Error("no");
  }
}

declare const stringly: ThrowingToString;

/** @nothrow */
export function convert(): string {
  return String(stringly);
}

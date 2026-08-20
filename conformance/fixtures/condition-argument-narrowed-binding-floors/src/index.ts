class Loud {
  startsWith(prefix: string): boolean {
    throw new Error(prefix);
  }
}

interface Bag {
  toString(): string;
}

/** @nothrow */
function beginsWith(value: string | Loud, prefix: string): boolean {
  return value.startsWith(prefix);
}

/** @nothrow */
function label(value: string | number | Bag): string {
  return value.toString();
}

/** @nothrow */
export function fromNarrowedMutable(): boolean {
  let value: string | Loud = "abc";
  const replace = (): void => {
    value = new Loud();
  };
  if (typeof value !== "string") return false;
  replace();
  return beginsWith(value, "a");
}

/** @nothrow */
export function fromNarrowedUnion(): string {
  let value: string | number = "a";
  const bump = (): void => {
    value = 1;
  };
  if (typeof value !== "string") return "";
  bump();
  return label(value);
}

/** @nothrow */
export function fromNarrowedConstant(): boolean {
  const value: string | Loud = "abc";
  if (typeof value !== "string") return false;
  return beginsWith(value, "a");
}

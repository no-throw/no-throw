class Loud {
  toString(): string {
    throw new Error("boom");
  }
}

/** @nothrow */
export function coercesBinding(): string {
  let value: string | Loud = "abc";
  const replace = (): void => {
    value = new Loud();
  };
  if (typeof value !== "string") return "";
  replace();
  return `${value}`;
}

/** @nothrow */
export function coercesConstant(value: string | Loud): string {
  const held = value;
  if (typeof held !== "string") return "";
  return `${held}`;
}

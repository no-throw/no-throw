interface Bag {
  startsWith(prefix: string): boolean;
}

/** @nothrow */
function beginsWith(value: string | Bag, prefix: string): boolean {
  return value.startsWith(prefix);
}

/** @nothrow */
export function fromNarrowedMutable(bag: Bag): boolean {
  let value: string | Bag = "abc";
  const replace = (): void => {
    value = bag;
  };
  if (typeof value !== "string") return false;
  replace();
  return beginsWith(value, "a");
}

/** @nothrow */
export function fromNarrowedConstant(): boolean {
  const value: string | Bag = "abc";
  if (typeof value !== "string") return false;
  return beginsWith(value, "a");
}

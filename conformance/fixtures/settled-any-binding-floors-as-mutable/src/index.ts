declare const opaque: any;

/** @nothrow */
export function evolving(flag: boolean): string {
  let value;
  if (flag) {
    value = "a";
  } else {
    value = "b";
  }
  return `${value}`;
}

/** @nothrow */
export function narrowedAny(): number {
  let value: any = opaque;
  if (typeof value !== "string") return 0;
  return value.length;
}

/** @nothrow */
export function declaredAny(value: any): number {
  return value.length;
}

/** @nothrow */
export function constantAny(): string {
  const value: any = opaque;
  if (typeof value !== "string") return "";
  return `${value}`;
}

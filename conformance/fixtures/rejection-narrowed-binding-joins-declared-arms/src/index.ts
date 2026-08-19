const rejected: Promise<number> = Promise.reject(new Error("boom"));

/** @nothrow */
export async function awaitsBinding(): Promise<number> {
  let value: Promise<number> | number = 1;
  const replace = (): void => void (value = rejected);
  if (typeof value !== "number") return 0;
  replace();
  return await value;
}

/** @nothrow */
export function returnsBinding(): Promise<number> | number {
  let value: Promise<number> | number = 1;
  const replace = (): void => void (value = rejected);
  if (typeof value !== "number") return 0;
  replace();
  return value;
}

/** @nothrow */
export function returnsConstant(value: Promise<number> | number): number {
  const held = value;
  if (typeof held !== "number") return 0;
  return held;
}

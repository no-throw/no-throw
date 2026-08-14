/** @nothrow */
export function digitsOf(value: number): string {
  return value.toPrecision();
}

/** @nothrow */
export function explicitlyNothing(value: number): string {
  return value.toPrecision(undefined);
}

/** @nothrow */
export function toThreeDigits(value: number): string {
  return value.toPrecision(3);
}

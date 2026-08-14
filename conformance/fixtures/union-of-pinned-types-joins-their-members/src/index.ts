/** @nothrow */
function label(value: string | number): string {
  return value.toString();
}

/** @nothrow */
export function caller(): string {
  return label("a");
}

/** @nothrow */
function widthOf(value: string | boolean): number {
  return value.toString().length;
}

/** @nothrow */
export function callerTwo(): number {
  return widthOf(true);
}

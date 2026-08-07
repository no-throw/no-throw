/** @nothrow */
export function quadruple(value: number): number {
  return double(double(value));
}

function double(value: number): number {
  return value * 2;
}

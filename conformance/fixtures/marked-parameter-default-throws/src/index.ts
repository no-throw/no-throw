function readFactor(): number {
  throw "boom";
}

/** @nothrow */
export function scaled(factor = readFactor()): number {
  return factor * 2;
}

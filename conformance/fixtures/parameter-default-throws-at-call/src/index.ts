function scaled(factor = readFactor()): number {
  return factor * 2;
}

function readFactor(): number {
  throw "boom";
}

/** @nothrow */
export function run(): number {
  return scaled();
}

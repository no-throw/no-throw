function* counter(start = readStart()): Generator<number> {
  yield start;
}

function readStart(): number {
  throw "boom";
}

/** @nothrow */
export function run(): Generator<number> {
  return counter();
}

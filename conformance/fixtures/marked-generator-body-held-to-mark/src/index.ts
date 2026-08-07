/** @nothrow */
export function* counter(): Generator<number> {
  yield 1;
  yield 2;
}

/** @nothrow */
export function* broken(): Generator<number> {
  yield 1;
  throw "boom";
}

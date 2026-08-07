/** @nothrow */
function* counter(): Generator<number> {
  yield 1;
}

/** @nothrow */
export function passThrough(source: Generator<number>): Generator<number> {
  return source;
}

/** @nothrow */
export function reassignable(): Generator<number> {
  let it = counter();
  return it;
}

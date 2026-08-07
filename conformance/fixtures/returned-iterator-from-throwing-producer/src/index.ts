function* broken(): Generator<number> {
  throw "boom";
}

/** @nothrow */
export function make(): Generator<number> {
  return broken();
}

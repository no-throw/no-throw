function* broken(): Generator<number> {
  throw "boom";
}

/** @nothrow */
export function start(): void {
  broken();
}

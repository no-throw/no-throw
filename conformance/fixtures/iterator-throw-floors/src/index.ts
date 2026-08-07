/** @nothrow */
export function* counter(): Generator<number> {
  yield 1;
}

/** @nothrow */
export function poke(): void {
  const it = counter();
  it.throw("boom");
}

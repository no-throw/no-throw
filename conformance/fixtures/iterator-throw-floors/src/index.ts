/** @nothrow */
export function* counter(): Generator<number> {
  yield 1;
}

class Cursor {
  [Symbol.iterator](): Cursor {
    return this;
  }

  next(): IteratorResult<number> {
    return { value: undefined, done: true };
  }

  throw(): IteratorResult<number> {
    return { value: undefined, done: true };
  }
}

/** @nothrow */
export function poke(): void {
  const it = counter();
  it.throw("boom");
}

/** @nothrow */
export function pokeCursor(): void {
  const cursor = new Cursor();
  cursor.throw();
}

function* broken(): Generator<number> {
  throw "boom";
}

function* clean(): Generator<number> {
  yield 1;
}

/** @nothrow */
export function* delegatesToClean(): Generator<number> {
  yield* clean();
}

/** @nothrow */
export function* delegatesToBroken(): Generator<number> {
  yield* broken();
}

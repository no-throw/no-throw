/** @nothrow */
export function first<T>(make: () => Generator<T>): T | undefined {
  const [head] = make();
  return head;
}

function* yieldsOne(): Generator<number> {
  yield 1;
}

function* throwsLater(): Generator<number> {
  yield 1;
  throw "boom";
}

function handsOnAThrower(): Generator<number> {
  return throwsLater();
}

function handsBackAny(): any {
  return throwsLater();
}

/** @nothrow */
export function ofClean(): number | undefined {
  return first(yieldsOne);
}

/** @nothrow */
export function ofLazyThrower(): number | undefined {
  return first(throwsLater);
}

/** @nothrow */
export function ofProducer(): number | undefined {
  return first(handsOnAThrower);
}

/** @nothrow */
export function ofAnErasedProducer(): number | undefined {
  return first(handsBackAny);
}

function* broken(): Generator<number> {
  throw "boom";
}

/** @nothrow */
export function total(): number {
  let sum = 0;
  try {
    for (const value of broken()) sum += value;
  } catch {
    return 0;
  }
  return sum;
}

/** @nothrow */
export function poke(): void {
  const it = broken();
  try {
    it.throw("stop");
  } catch {
    return;
  }
}

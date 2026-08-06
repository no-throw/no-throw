/** @nothrow */
export function makeThrower(): () => void {
  function inner(): void {
    throw new Error("boom");
  }

  return inner;
}

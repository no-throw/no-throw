/** @nothrow */
export function countdown(from: number): number {
  return step(from);
}

function step(remaining: number): number {
  return remaining <= 0 ? 0 : step(remaining - 1);
}

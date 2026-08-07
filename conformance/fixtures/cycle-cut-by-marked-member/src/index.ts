/** @nothrow */
export function ping(depth: number): void {
  if (depth > 0) pong(depth - 1);
}

function pong(depth: number): void {
  ping(depth);
}

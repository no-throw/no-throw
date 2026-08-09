declare function g(): void;
declare function make(): () => void;

/** @nothrow */
export const f = g;

/** @nothrow */
export default g;

export class Service {
  /** @nothrow */
  handle = make();
}

export function attempt(): number {
  /** @nothrow */
  const total = 1 + 1;
  return total;
}

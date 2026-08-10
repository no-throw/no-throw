import { Wrapper } from "wrapped";

/** @nothrow */
export function wrap(size: number): Wrapper {
  return new Wrapper(size);
}

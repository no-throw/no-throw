import { safeParse } from "flaky";

/** @nothrow */
export function read(text: string): number {
  return safeParse(text);
}

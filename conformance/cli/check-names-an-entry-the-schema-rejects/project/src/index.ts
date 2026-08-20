import { safeParse } from "flaky";

/** @nothrow */
export function parse(text: string): unknown {
  return safeParse(text);
}

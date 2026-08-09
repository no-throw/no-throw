import { boom, safeParse } from "flaky";

/** @nothrow */
export function parse(text: string): unknown {
  return safeParse(text);
}

/** @nothrow */
export function detonate(): void {
  boom();
}

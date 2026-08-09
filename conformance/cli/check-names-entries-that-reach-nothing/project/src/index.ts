import { safeParse } from "facade";

/** @nothrow */
export function parse(text: string): unknown {
  return safeParse(text);
}

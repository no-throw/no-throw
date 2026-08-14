import { boom, parse } from "dual";

/** @nothrow */
export function read(text: string): unknown {
  return parse(text);
}

/** @nothrow */
export function detonate(): void {
  boom();
}

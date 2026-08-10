import { clamp, parseOrThrow } from "legacy";

/** @nothrow */
export function bounded(value: number): number {
  return clamp(value, 10);
}

/** @nothrow */
export function read(text: string): unknown {
  return parseOrThrow(text);
}

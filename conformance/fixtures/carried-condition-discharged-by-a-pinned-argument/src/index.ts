import { beginsWith } from "parsing";

/** @nothrow */
export function fromLiteral(): boolean {
  return beginsWith("abc", "a");
}

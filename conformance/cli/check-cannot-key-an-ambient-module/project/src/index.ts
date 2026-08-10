import { build } from "widget";

/** @nothrow */
export function make(name: string): string {
  return build(name);
}

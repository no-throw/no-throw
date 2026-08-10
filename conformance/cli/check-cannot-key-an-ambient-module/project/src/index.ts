import { posix } from "node:path";

/** @nothrow */
export function under(directory: string): string {
  return posix.join(directory, "index.js");
}

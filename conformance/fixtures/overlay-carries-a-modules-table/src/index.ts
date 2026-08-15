import path from "node:path";

/** @nothrow */
export function under(directory: string): string {
  return path.join(directory, "index.js");
}

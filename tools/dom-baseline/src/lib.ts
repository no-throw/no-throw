import { createLibProgram } from "@no-throw/core/baseline";
import type { LibProgram } from "@no-throw/core/baseline";
import type ts from "typescript";

/**
 * The DOM libs, and only them plus what they depend on. `lib.dom.d.ts` refers
 * to `Promise`, `ArrayBuffer` and the iteration protocol, so the ES libs have
 * to be in the program for the checker to answer anything — but the inventory
 * walk filters back down to files whose lib target starts with `dom`.
 */
export const DOM_LIBS = [
  "lib.dom.d.ts",
  "lib.dom.iterable.d.ts",
  "lib.dom.asynciterable.d.ts",
  "lib.esnext.d.ts",
];

export function createDomProgram(tsApi: typeof ts): LibProgram {
  return createLibProgram(tsApi, DOM_LIBS);
}

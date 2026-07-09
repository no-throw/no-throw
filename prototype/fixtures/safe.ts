// safe.ts — CASE 1: a non-throwing function calling another non-throwing
// function ACROSS A FILE BOUNDARY. Also exercises #4 inference: `double` is
// unmarked but inferred non-throwing, so no bridge is required. Expect: PASS.
import { add, double } from './math';

/** @nothrow */
export function sumAndDouble(a: number, b: number): number {
  return double(add(a, b)); // add = declared non-throwing; double = inferred non-throwing
}

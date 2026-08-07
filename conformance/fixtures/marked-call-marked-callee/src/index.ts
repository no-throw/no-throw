import { double } from "./math.js";

/** @nothrow */
export function quadruple(value: number): number {
  return double(double(value));
}

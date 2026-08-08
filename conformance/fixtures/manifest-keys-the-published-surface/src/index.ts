import { renamed } from "multi";
import { deepFn } from "multi/deep";

/** @nothrow */
export function callRenamed(): void {
  renamed();
}

/** @nothrow */
export function callDeep(): void {
  deepFn();
}

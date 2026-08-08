import { overlaid, overridden, shipped } from "flaky";

/** @nothrow */
export function callAll(): void {
  overlaid();
  overridden();
  shipped();
}

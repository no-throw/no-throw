import { shippedClean, shippedThrowing } from "flaky";

/** @nothrow */
export function callTheOverlaidThrowingOne(): void {
  shippedClean();
}

/** @nothrow */
export function callTheOverlaidCleanOne(): void {
  shippedThrowing();
}

import { overlaidClean, overlaidThrowing } from "flaky";

/** @nothrow */
export function callTheOverriddenThrowingOne(): void {
  overlaidClean();
}

/** @nothrow */
export function callTheOverriddenCleanOne(): void {
  overlaidThrowing();
}

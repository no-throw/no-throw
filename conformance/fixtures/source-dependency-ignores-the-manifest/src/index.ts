import { honest, risky } from "flaky";

/** @nothrow */
export function callHonest(): void {
  honest();
}

/** @nothrow */
export function callRisky(): void {
  risky();
}

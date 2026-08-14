import { untilNullish, untilUndefined } from "flaky";

/** @nothrow */
export function omitted(): void {
  untilUndefined();
}

/** @nothrow */
export function spelledUndefined(): void {
  untilUndefined(undefined);
}

/** @nothrow */
export function spelledNull(): void {
  untilUndefined(null);
}

/** @nothrow */
export function nullishTakesNull(): void {
  untilNullish(null);
}

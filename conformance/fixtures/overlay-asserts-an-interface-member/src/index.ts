import { _ } from "lodashish";

/** @nothrow */
export function group(xs: readonly number[]): number[][] {
  return _.chunk(xs, 2);
}

/** @nothrow */
export function detonate(): void {
  _.detonate();
}

/** @nothrow */
export function version(): string {
  return _.version;
}

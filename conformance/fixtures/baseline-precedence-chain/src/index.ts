import { overlaid, overridden, shipped, uncolored } from "flaky";

interface Config {
  readonly [key: string]: string;
}

/** @nothrow */
export function everyRung(config: Config): string[] {
  overridden();
  overlaid();
  shipped();
  uncolored();
  return Object.keys(config);
}

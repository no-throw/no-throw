import { eachItem, safeParse } from "flaky";

/** @nothrow */
const shout = (item: string): void => {
  void item;
};

/** @nothrow */
export function greetAll(items: readonly string[]): void {
  eachItem(items, shout);
}

/** @nothrow */
export function parse(text: string): unknown {
  return safeParse(text);
}

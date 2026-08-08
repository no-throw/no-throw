import { eachItem } from "flaky";

/** @nothrow */
const shout = (item: string): void => {
  void item;
};

/** @nothrow */
export function greetAll(items: readonly string[]): void {
  eachItem(items, shout);
}

/** @nothrow */
export function breakAll(items: readonly string[]): void {
  eachItem(items, (item) => {
    throw item;
  });
}

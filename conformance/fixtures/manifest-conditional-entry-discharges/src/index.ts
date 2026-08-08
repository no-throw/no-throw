import { eachItem, saveAll } from "flaky";

/** @nothrow */
const shout = (item: string): void => {
  void item;
};

const clean = {
  save(item: string): void {
    void item;
  },
};

const dirty = {
  save(item: string): void {
    throw item;
  },
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

/** @nothrow */
export function saveClean(items: readonly string[]): void {
  saveAll(items, clean);
}

/** @nothrow */
export function saveDirty(items: readonly string[]): void {
  saveAll(items, dirty);
}

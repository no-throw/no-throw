interface Item {
  readonly raw: string;
}

interface Repo {
  save(item: Item): void;
}

/** @nothrow */
export function saveAllB(items: readonly Item[], repo: Repo): void {
  for (let i = 0; i < items.length; i += 1) repo.save(items[i]);
}

/** @nothrow */
export function persist(items: readonly Item[]): void {
  saveAllB(items, goodRepo);
}

const goodRepo = {
  save(item: Item): void {
    saved.last = item.raw;
  },
};

const saved = { last: "" };

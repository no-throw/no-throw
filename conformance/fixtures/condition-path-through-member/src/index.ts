interface Item {
  readonly raw: string;
}

interface Repo {
  save(item: Item): void;
}

/** @nothrow */
export function saveAllB(items: readonly Item[], repo: Repo): void {
  for (const item of items) repo.save(item);
}

/** @nothrow */
export function persist(items: readonly Item[]): void {
  saveAllB(items, goodRepo);
}

const goodRepo = {
  save(item: Item): void {
    saved[saved.length] = item.raw;
  },
};

const saved: string[] = [];

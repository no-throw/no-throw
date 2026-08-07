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
  saveAllB(items, badRepo);
}

const badRepo = {
  save(item: Item): void {
    saved[saved.length] = JSON.parse(item.raw);
  },
};

const saved: unknown[] = [];

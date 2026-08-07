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
  saveAllB(items, badRepo);
}

const badRepo = {
  save(item: Item): void {
    saved[saved.length] = JSON.parse(item.raw);
  },
};

const saved: unknown[] = [];

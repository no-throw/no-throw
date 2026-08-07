interface Item {
  readonly raw: string;
}

class BaseRepo {
  save(item: Item): void {
    saved[saved.length] = item.raw;
  }
}

class BadRepo extends BaseRepo {
  override save(item: Item): void {
    saved[saved.length] = JSON.parse(item.raw);
  }
}

/** @nothrow */
export function saveAllB(items: readonly Item[], repo: BaseRepo): void {
  for (let i = 0; i < items.length; i += 1) repo.save(items[i]);
}

/** @nothrow */
export function persist(items: readonly Item[]): void {
  const repo: BaseRepo = new BadRepo();
  saveAllB(items, repo);
}

const saved: unknown[] = [];

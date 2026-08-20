interface Bag {
  items: Map<string, number>;
}

/** @nothrow */
export function viaParameter(bag: Bag): number {
  let n = 0;
  for (const value of bag.items.values()) n = value;
  return n;
}

/** @nothrow */
export function viaLocalAlias(bag: Bag): number {
  const local = bag;
  let n = 0;
  for (const value of local.items.values()) n = value;
  return n;
}

/** @nothrow */
export function paramIsMap(map: Map<string, number>): number {
  let n = 0;
  for (const value of map.values()) n = value;
  return n;
}

/** @nothrow */
export function paramIsArray(items: string[]): number {
  let n = 0;
  for (const item of items) n = item.length;
  return n;
}

/** @nothrow */
export function paramIsArrayEntries(items: string[]): number {
  let n = 0;
  for (const [index] of items.entries()) n = index;
  return n;
}

class LazilyThrowingMap extends Map<string, number> {
  /** @nothrow */
  constructor() {
    super();
  }

  override *values(): IterableIterator<number> {
    yield 1;
    throw "boom";
  }
}

/** @nothrow */
export function ofAPlainMap(): number {
  return paramIsMap(new Map());
}

/** @nothrow */
export function ofAnOverridingSubclass(): number {
  return paramIsMap(new LazilyThrowingMap());
}

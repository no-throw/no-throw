class Safe {
  get p(): number {
    return 1;
  }
}

class Risky {
  get p(): number {
    throw new Error("boom");
  }
}

class Holder {
  value: Safe | Risky = new Safe();
}

/** @nothrow */
export function readsBinding(): number {
  let o: Safe | Risky = new Safe();
  const swap = (): void => {
    o = new Risky();
  };
  if (!(o instanceof Safe)) return 0;
  swap();
  return o.p;
}

/** @nothrow */
export function readsProperty(holder: Holder): number {
  const swap = (): void => {
    holder.value = new Risky();
  };
  if (!(holder.value instanceof Safe)) return 0;
  swap();
  return holder.value.p;
}

/** @nothrow */
export function readsByKey(): number {
  let o: Safe | Risky = new Safe();
  const swap = (): void => {
    o = new Risky();
  };
  if (!(o instanceof Safe)) return 0;
  swap();
  return o["p"];
}

/** @nothrow */
export function destructures(): number {
  let o: Safe | Risky = new Safe();
  const swap = (): void => {
    o = new Risky();
  };
  if (!(o instanceof Safe)) return 0;
  swap();
  const { p } = o;
  return p;
}

/** @nothrow */
export function readsConstant(o: Safe | Risky): number {
  const value = o;
  if (!(value instanceof Safe)) return 0;
  return value.p;
}

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

interface Holder {
  inner: Safe | Risky;
}

interface Plain {
  inner: Safe;
}

/** @nothrow */
export function nestedBinding(): number {
  let holder: Holder = { inner: new Safe() };
  const swap = (): void => {
    holder = { inner: new Risky() };
  };
  if (!(holder.inner instanceof Safe)) return 0;
  swap();
  const {
    inner: { p },
  } = holder;
  return p;
}

/** @nothrow */
export function nestedClean(holder: Plain): number {
  const {
    inner: { p },
  } = holder;
  return p;
}

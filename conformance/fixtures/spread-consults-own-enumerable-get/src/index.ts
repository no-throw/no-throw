class Box {
  data = 1;

  get value(): number {
    throw new Error("no");
  }
}

interface Described {
  get label(): string;
}

const literal = {
  data: 1,
  get value(): number {
    throw new Error("no");
  },
};

const plain = { other: 2 };

declare const box: Box;
declare const described: Described;
declare const flag: boolean;

/** @nothrow */
export function spreadInstance(): object {
  return { ...box };
}

/** @nothrow */
export function restInstance(): object {
  const { data, ...rest } = box;
  return { data, rest };
}

/** @nothrow */
export function spreadLiteral(): object {
  return { ...literal };
}

/** @nothrow */
export function spreadDescribed(): object {
  return { ...described };
}

/** @nothrow */
export function spreadEither(): object {
  return { ...(flag ? literal : plain) };
}

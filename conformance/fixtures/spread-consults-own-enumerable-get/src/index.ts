class Box {
  data = 1;

  get value(): number {
    throw new Error("no");
  }
}

const literal = {
  data: 1,
  get value(): number {
    throw new Error("no");
  },
};

declare const box: Box;

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

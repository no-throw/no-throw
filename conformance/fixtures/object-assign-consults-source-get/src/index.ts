class Box {
  get value(): number {
    throw new Error("no");
  }
}

const literal = {
  get value(): number {
    throw new Error("no");
  },
};

declare const box: Box;
declare const target: Record<string, unknown>;

/** @nothrow */
export function fromInstance(): object {
  return Object.assign(target, box);
}

/** @nothrow */
export function fromLiteral(): object {
  return Object.assign(target, literal);
}

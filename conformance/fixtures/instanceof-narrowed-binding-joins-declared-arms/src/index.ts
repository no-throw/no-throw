class Plain {
  static readonly plain = true;
}

class Hostile {
  static [Symbol.hasInstance](value: unknown): boolean {
    throw new Error(String(value));
  }
}

/** @nothrow */
export function checksBinding(value: unknown): boolean {
  let constructor: typeof Plain | typeof Hostile = Plain;
  const replace = (): void => {
    constructor = Hostile;
  };
  if (!("plain" in constructor)) return false;
  replace();
  return value instanceof constructor;
}

/** @nothrow */
export function checksConstant(
  value: unknown,
  constructor: typeof Plain | typeof Hostile,
): boolean {
  const held = constructor;
  if (!("plain" in held)) return false;
  return value instanceof held;
}

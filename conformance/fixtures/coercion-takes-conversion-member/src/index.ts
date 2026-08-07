class Quiet {
  [Symbol.toPrimitive](hint: string): string {
    return hint;
  }

  valueOf(): number {
    return 1;
  }

  toString(): string {
    return "";
  }
}

class ThrowingToString {
  [Symbol.toPrimitive](hint: string): string {
    return hint;
  }

  valueOf(): number {
    return 1;
  }

  toString(): string {
    throw new Error("no");
  }
}

class ThrowingValueOf {
  [Symbol.toPrimitive](hint: string): string {
    return hint;
  }

  valueOf(): number {
    throw new Error("no");
  }

  toString(): string {
    return "";
  }
}

class ThrowingToPrimitive {
  [Symbol.toPrimitive](hint: string): string {
    throw new Error("no");
  }

  valueOf(): number {
    return 1;
  }

  toString(): string {
    return "";
  }
}

declare const quiet: Quiet;
declare const stringly: ThrowingToString;
declare const numerically: ThrowingValueOf;
declare const primitively: ThrowingToPrimitive;

/** @nothrow */
export function interpolateQuiet(): string {
  return `${quiet}`;
}

/** @nothrow */
export function interpolate(): string {
  return `${stringly}`;
}

/** @nothrow */
export function negate(): number {
  return +numerically;
}

/** @nothrow */
export function compare(): boolean {
  return primitively == "x";
}

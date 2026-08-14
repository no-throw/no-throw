/** @nothrow */
function helper(s: string): boolean {
  return s.startsWith("a");
}

/** @nothrow */
export function callerWithLiteral(): boolean {
  return helper("abc");
}

/** @nothrow */
export function callerWithParameter(input: string): boolean {
  return helper(input);
}

/** @nothrow */
export function callerWithExpression(a: string, b: string): boolean {
  return helper(a.concat(b));
}

/** @nothrow */
function counted(n: number): boolean {
  return n.valueOf() > 0;
}

/** @nothrow */
export function callerWithNumber(): boolean {
  return counted(2);
}

/** @nothrow */
function isPositive(n: bigint): boolean {
  return n.valueOf() > 0n;
}

/** @nothrow */
export function callerWithBigInt(): boolean {
  return isPositive(1n);
}

/** @nothrow */
function named(s: symbol): string {
  return s.toString();
}

/** @nothrow */
export function callerWithSymbol(): string {
  return named(Symbol.iterator);
}

/** @nothrow */
function trimmed<T extends string>(s: T): string {
  return s.trim();
}

/** @nothrow */
export function callerWithConstrainedParameter(): string {
  return trimmed(" a ");
}

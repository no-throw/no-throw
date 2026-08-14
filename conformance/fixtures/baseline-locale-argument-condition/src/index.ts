/** @nothrow */
export function sameString(a: string, b: string): boolean {
  return a.localeCompare(b) === 0;
}

/** @nothrow */
export function explicitlyNoLocale(a: string, b: string): number {
  return a.localeCompare(b, undefined);
}

/** @nothrow */
export function inLocale(a: string, b: string, locale: string): number {
  return a.localeCompare(b, locale);
}

/** @nothrow */
export function ignoringCase(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "accent" });
}

/** @nothrow */
export function spelled(n: number): string {
  return n.toLocaleString();
}

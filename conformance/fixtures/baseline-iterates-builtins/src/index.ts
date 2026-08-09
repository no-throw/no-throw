/** @nothrow */
export function lastOf(items: readonly string[]): string {
  let out = "";
  for (const item of items) out = item;
  return out;
}

/** @nothrow */
export function lastEntry(pairs: Map<string, string>): string {
  let out = "";
  for (const pair of pairs) out = pair[0];
  return out;
}

/** @nothrow */
export function lastCharacter(text: string): string {
  let out = "";
  for (const character of text) out = character;
  return out;
}

/** @nothrow */
export function spread(items: readonly string[]): readonly string[] {
  return [...items];
}

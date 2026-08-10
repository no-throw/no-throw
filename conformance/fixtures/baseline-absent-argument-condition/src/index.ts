type Entries = readonly (readonly [string, string])[];

/** @nothrow */
export function emptyMap(): Map<string, string> {
  return new Map();
}

/** @nothrow */
export function emptyTypedMap(): Map<string, string> {
  return new Map<string, string>();
}

/** @nothrow */
export function emptySet(): Set<string> {
  return new Set<string>();
}

/** @nothrow */
export function explicitlyNothing(): Map<string, string> {
  return new Map<string, string>(undefined);
}

/** @nothrow */
export function fromEntries(entries: Entries): Map<string, string> {
  return new Map(entries);
}

/** @nothrow */
export function narrowedToNothing(entries: Entries): Map<string, string> {
  let held: Entries | undefined = undefined;
  const fill = (): void => {
    held = entries;
  };
  fill();
  return new Map(held);
}

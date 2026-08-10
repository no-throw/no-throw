/** @nothrow */
export function parseArgs(
  argv: readonly string[],
  parsed: Map<string, string>,
  seen: Set<string>,
): Map<string, string> {
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.substring(2, eq);
    if (seen.has(name)) continue;
    seen.add(name);
    parsed.set(name, eq === -1 ? "" : arg.slice(eq + 1));
  }
  return parsed;
}

/** @nothrow */
export function lookup(parsed: Map<string, string>, name: string): string {
  return parsed.get(name) ?? "";
}

/** @nothrow */
export function pairs(record: Record<string, string>): [string, string][] {
  return Object.entries(record);
}

/** @nothrow */
export function empty(): Map<string, string> {
  return new Map();
}

/**
 * Reading the suite's own data files. Both halves of the suite are data — a
 * fixture's `expected.json` and a CLI case's `case.json` — and both are held to
 * the same standard: a typo in either must fail loudly, because the failure
 * mode of a silently-ignored key is a case that passes without asserting
 * anything.
 *
 * `where` is what the message leads with: the file, and the path inside it.
 */

export function asRecord(
  value: unknown,
  where: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function readString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${where}: \`${key}\` must be a non-empty string`);
  }
  return value;
}

/**
 * A string that may be empty, for the one thing an empty one says something
 * about: text to write, where writing nothing is deleting.
 */
export function readText(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${where}: \`${key}\` must be a string`);
  }
  return value;
}

export function readStrings(
  record: Record<string, unknown>,
  key: string,
  where: string,
): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((each) => typeof each !== "string")) {
    throw new Error(`${where}: \`${key}\` must be an array of strings`);
  }
  return value as string[];
}

export function rejectUnknownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      throw new Error(`${where}: unknown key \`${key}\``);
    }
  }
}

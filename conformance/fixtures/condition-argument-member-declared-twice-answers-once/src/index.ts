interface Normalizable {
  normalize(form: string): string;
}

interface Splittable {
  split(separator: string): string[];
}

/** @nothrow */
function normalized(s: Normalizable): string {
  return s.normalize("NFC");
}

/** @nothrow */
function parts(s: Splittable): string[] {
  return s.split(",");
}

/** @nothrow */
export function normalizesAString(): string {
  return normalized("abc");
}

/** @nothrow */
export function splitsAString(): string[] {
  return parts("a,b");
}

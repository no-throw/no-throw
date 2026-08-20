interface Searchable {
  indexOf(needle: string): number;
}

interface Joinable {
  join(separator: string): string;
}

/** @nothrow */
function positionOfA(xs: Searchable): number {
  return xs.indexOf("a");
}

/** @nothrow */
function commaJoined(xs: Joinable): string {
  return xs.join(",");
}

/** @nothrow */
export function searchesALiteral(): number {
  return positionOfA(["a", "b"]);
}

/** @nothrow */
export function searchesABoundLiteral(): number {
  const xs = ["a", "b"];
  return positionOfA(xs);
}

/** @nothrow */
export function joinsALiteral(): string {
  return commaJoined(["a", "b"]);
}

declare const box: { readonly items: readonly string[] };

/** @nothrow */
export function searchesADeclaredArray(): number {
  return positionOfA(box.items);
}

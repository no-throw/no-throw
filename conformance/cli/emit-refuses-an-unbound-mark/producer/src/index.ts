export interface Parser {
  /** @nothrow */
  parse(text: string): number;
}

/** @nothrow */
export function parse(text: string): number {
  return text.length;
}

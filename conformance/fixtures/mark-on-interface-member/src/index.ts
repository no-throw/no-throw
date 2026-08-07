export interface Parser {
  /** @nothrow */
  parse(input: string): unknown;
}

export abstract class Parser {
  /** @nothrow */
  abstract parse(input: string): unknown;
}

declare function decode(text: string): unknown;

/** @nothrow */
export function parse(text: string): unknown {
  return decode(text);
}

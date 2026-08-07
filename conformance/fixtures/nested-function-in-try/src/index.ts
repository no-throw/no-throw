/** @nothrow */
export function makeParser(text: string): () => unknown {
  try {
    /** @nothrow */
    const parse = (): unknown => JSON.parse(text);
    return parse;
  } catch {
    return () => null;
  }
}

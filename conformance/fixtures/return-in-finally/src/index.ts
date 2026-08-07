/** @nothrow */
export function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } finally {
    return null;
  }
}

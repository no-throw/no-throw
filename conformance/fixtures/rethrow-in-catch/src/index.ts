/** @nothrow */
export function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw error;
  }
}

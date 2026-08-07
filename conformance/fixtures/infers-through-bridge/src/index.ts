/** @nothrow */
export function read(text: string): unknown {
  return parse(text);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

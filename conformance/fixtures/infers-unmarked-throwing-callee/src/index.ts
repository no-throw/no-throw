/** @nothrow */
export function read(text: string): unknown {
  return parse(text);
}

function parse(text: string): unknown {
  return JSON.parse(text);
}

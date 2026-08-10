/** @nothrow */
export function clamp(value: number, max: number): number {
  return value > max ? max : value;
}

export function parseOrThrow(text: string): unknown {
  return JSON.parse(text);
}

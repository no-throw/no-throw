function first(parts: TemplateStringsArray, value: number): number {
  return value;
}

/** @nothrow */
export function pick(id: number): number {
  return first`id ${id}`;
}

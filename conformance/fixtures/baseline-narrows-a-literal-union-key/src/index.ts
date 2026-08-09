/** @nothrow */
export function pick(element: Element, key: "id" | "className"): string {
  return element[key];
}

/** @nothrow */
export function pickMarkup(element: Element, key: "id" | "innerHTML"): string {
  return element[key];
}

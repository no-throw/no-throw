/** @nothrow */
export function first<T>(make: () => Generator<T>): T | undefined {
  const [head] = make();
  return head;
}

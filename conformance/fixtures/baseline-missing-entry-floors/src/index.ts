/** @nothrow */
export function target(reference: WeakRef<object>): object | undefined {
  return reference.deref();
}

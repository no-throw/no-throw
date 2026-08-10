/** @nothrow */
export function parse(text: string): unknown {
  return JSON.parse(text);
}

/** @nothrow */
export function read(reference: WeakRef<object>): object | undefined {
  return reference.deref();
}

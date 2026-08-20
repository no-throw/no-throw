/** @nothrow */
export function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index];
}

/** @nothrow */
export function size(bytes: Uint8Array): number {
  return bytes.length;
}

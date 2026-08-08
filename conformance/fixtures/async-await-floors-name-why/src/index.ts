declare const source: { pending: Promise<number> };

/** @nothrow */
export async function awaitsMutableBinding(): Promise<number> {
  let pending = source.pending;
  return await pending;
}

/** @nothrow */
export async function awaitsParameter(
  pending: Promise<number>,
): Promise<number> {
  return await pending;
}

/** @nothrow */
export async function awaitsProperty(): Promise<number> {
  return await source.pending;
}

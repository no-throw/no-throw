/** @nothrow */
async function resolves(): Promise<number> {
  return 1;
}

/** @nothrow */
export async function awaitsAParameterCall(
  produce: () => Promise<number>,
): Promise<number> {
  return await produce();
}

/** @nothrow */
export async function passesAParameterAsAHandler(
  handle: (value: number) => number,
): Promise<number> {
  return await resolves().then(handle);
}

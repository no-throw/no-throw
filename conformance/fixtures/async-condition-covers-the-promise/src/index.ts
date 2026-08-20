/** @nothrow */
async function resolves(): Promise<number> {
  return 1;
}

async function rejects(): Promise<number> {
  throw "boom";
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

/** @nothrow */
export async function ofResolving(): Promise<number> {
  return await awaitsAParameterCall(resolves);
}

/** @nothrow */
export async function ofRejecting(): Promise<number> {
  return await awaitsAParameterCall(rejects);
}

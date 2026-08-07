async function rejects(): Promise<number> {
  throw "boom";
}

/** @nothrow */
async function resolves(): Promise<number> {
  return 1;
}

/** @nothrow */
function recover(): number {
  return 0;
}

function dirty(): number {
  throw "boom";
}

/** @nothrow */
export async function cleanSourceNeverRunsTheHandler(): Promise<void> {
  await resolves().catch(dirty);
}

/** @nothrow */
export async function throwingSourceTakesTheHandler(): Promise<void> {
  await rejects().catch(recover);
}

/** @nothrow */
export async function throwingSourceAndThrowingHandler(): Promise<void> {
  await rejects().catch(dirty);
}

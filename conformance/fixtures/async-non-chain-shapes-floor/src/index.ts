declare const method: "then";

async function rejects(): Promise<number> {
  throw "boom";
}

/** @nothrow */
function keep(value: number): number {
  return value;
}

/** @nothrow */
export async function storedPartialChain(): Promise<void> {
  const partial = rejects().then(keep);
  await partial;
}

/** @nothrow */
export async function dynamicMethodName(): Promise<void> {
  await rejects()[method](keep);
}

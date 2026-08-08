declare function opaque(value: number): number;

/** @nothrow */
async function resolves(): Promise<number> {
  return 1;
}

function dirty(): number {
  throw "boom";
}

/** @nothrow */
export async function inlineArrowInferredClean(): Promise<void> {
  await resolves().then((value) => value);
}

/** @nothrow */
export async function inlineArrowInferredThrowing(): Promise<void> {
  await resolves().then(() => {
    throw "boom";
  });
}

/** @nothrow */
export async function referenceResolved(): Promise<void> {
  await resolves().then(dirty);
}

/** @nothrow */
export async function opaqueHandlerFloors(): Promise<void> {
  await resolves().then(opaque);
}

/** @nothrow */
async function resolves(): Promise<number> {
  return 1;
}

/** @nothrow */
function keep(value: number): number {
  return value;
}

function dirty(): number {
  throw "boom";
}

/** @nothrow */
export async function throwingHandler(): Promise<void> {
  await resolves().then(dirty);
}

/** @nothrow */
export async function cleanHandler(): Promise<void> {
  await resolves().then(keep);
}

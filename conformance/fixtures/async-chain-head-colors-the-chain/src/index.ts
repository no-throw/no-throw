async function rejects(): Promise<number> {
  throw "boom";
}

/** @nothrow */
async function resolves(): Promise<number> {
  return 1;
}

/** @nothrow */
function keep(value: number): number {
  return value;
}

/** @nothrow */
export async function throwingHead(): Promise<void> {
  await rejects().then(keep);
}

/** @nothrow */
export async function cleanHead(): Promise<void> {
  await resolves().then(keep);
}

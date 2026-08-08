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
function recover(): number {
  return 0;
}

function dirty(): number {
  throw "boom";
}

/** @nothrow */
export async function rejectionDischarged(): Promise<void> {
  await rejects().then(keep, recover);
}

/** @nothrow */
export async function throwingSecondHandler(): Promise<void> {
  await resolves().then(keep, dirty);
}

async function rejects(): Promise<number> {
  throw "boom";
}

/** @nothrow */
async function resolves(): Promise<number> {
  return 1;
}

/** @nothrow */
function done(): void {}

function dirty(): void {
  throw "boom";
}

/** @nothrow */
export async function throwingSource(): Promise<void> {
  await rejects().finally(done);
}

/** @nothrow */
export async function throwingFinallyHandler(): Promise<void> {
  await resolves().finally(dirty);
}

/** @nothrow */
export async function bothClean(): Promise<void> {
  await resolves().finally(done);
}

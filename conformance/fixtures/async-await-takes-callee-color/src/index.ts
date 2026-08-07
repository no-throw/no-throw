async function rejects(): Promise<number> {
  throw "boom";
}

/** @nothrow */
async function resolves(): Promise<number> {
  return 1;
}

/** @nothrow */
export async function awaitsThrowing(): Promise<number> {
  return await rejects();
}

/** @nothrow */
export async function awaitsClean(): Promise<number> {
  return await resolves();
}

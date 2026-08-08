async function rejects(): Promise<number> {
  throw "boom";
}

/** @nothrow */
async function resolves(): Promise<number> {
  return 1;
}

/** @nothrow */
export async function startEarlyAwaitLater(): Promise<number> {
  const pending = rejects();
  const other = await resolves();
  return other + (await pending);
}

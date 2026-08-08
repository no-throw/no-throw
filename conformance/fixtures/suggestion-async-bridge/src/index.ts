async function rejects(): Promise<void> {
  throw "boom";
}

/** @nothrow */
export async function awaitsRejecting(): Promise<void> {
  await rejects();
}

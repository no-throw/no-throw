async function rejects(): Promise<void> {
  throw "boom";
}

/** @nothrow */
export async function discardsRejecting(): Promise<void> {
  rejects();
}

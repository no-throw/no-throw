async function rejects(): Promise<void> {
  throw "boom";
}

/** @nothrow */
export async function whenAsked(wanted: boolean): Promise<void> {
  if (wanted) rejects();
}

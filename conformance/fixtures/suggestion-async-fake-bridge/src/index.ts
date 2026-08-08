async function rejects(): Promise<void> {
  throw "boom";
}

/** @nothrow */
export async function pretendsToBridge(): Promise<void> {
  try {
    rejects();
  } catch {
    return;
  }
}

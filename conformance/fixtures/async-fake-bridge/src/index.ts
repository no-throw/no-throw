async function rejects(): Promise<void> {
  throw "boom";
}

/** @nothrow */
export function pretendsToBridge(): void {
  try {
    rejects();
  } catch {
    return;
  }
}

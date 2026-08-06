/** @nothrow */
export function attempt(): string {
  try {
    throw new Error("boom");
  } catch {
    return "failed";
  }
}

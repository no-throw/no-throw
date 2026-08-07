export const service = {
  /** @nothrow */
  fail(): void {
    throw new Error("boom");
  },
};

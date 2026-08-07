export const box = {
  /** @nothrow */
  get value(): number {
    throw new Error("boom");
  },
};

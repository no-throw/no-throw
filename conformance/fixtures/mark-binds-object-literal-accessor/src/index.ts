export const box = {
  /** @nothrow */
  get value(): number {
    throw "boom";
  },
};

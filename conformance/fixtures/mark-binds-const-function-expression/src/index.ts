/** @nothrow */
export const fail = function (): void {
  throw new Error("boom");
};

declare const target: { handle: () => void };

export function outer(): void {
  /** @nothrow */
  target.handle = (): void => {
    throw "boom";
  };
}

declare function risky(): void;

export function makeHandlers(): { readonly run: () => void } {
  return {
    /** @nothrow */
    run: (): void => risky(),
  };
}

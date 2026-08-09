declare function each(visit: () => void): void;

export function outer(): void {
  each(/** @nothrow */ () => {
    throw "boom";
  });

  each(
    /** @nothrow */ ((): void => {
      throw "boom";
    }),
  );
}

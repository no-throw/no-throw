export class Service {
  /** @nothrow */
  handle = (): void => {
    throw new Error("boom");
  };
}

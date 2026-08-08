export class Service {
  /** @nothrow */
  accessor handle = (): void => {
    throw "boom";
  };
}

function load(): number {
  throw "boom";
}

export class Service {
  private readonly port = load();

  /** @nothrow */
  constructor() {}
}

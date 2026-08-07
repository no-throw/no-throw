class Base {
  constructor() {
    throw "boom";
  }
}

export class Derived extends Base {
  /** @nothrow */
  constructor() {
    super();
  }
}

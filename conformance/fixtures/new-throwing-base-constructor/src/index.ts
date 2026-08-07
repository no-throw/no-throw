class Base {
  constructor() {
    throw "boom";
  }
}

class Derived extends Base {
  readonly ready = true;
}

/** @nothrow */
export function build(): Derived {
  return new Derived();
}

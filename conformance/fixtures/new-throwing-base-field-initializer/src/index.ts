class Base {
  readonly port = readPort();
}

class Derived extends Base {}

function readPort(): number {
  throw "boom";
}

/** @nothrow */
export function build(): Derived {
  return new Derived();
}

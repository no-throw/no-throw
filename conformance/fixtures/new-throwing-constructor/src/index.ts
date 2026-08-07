class Service {
  constructor() {
    throw "boom";
  }
}

/** @nothrow */
export function build(): Service {
  return new Service();
}

class Service {
  constructor() {
    throw "boom";
  }
}

/** @nothrow */
export function build(): Service | undefined {
  try {
    return new Service();
  } catch {
    return undefined;
  }
}

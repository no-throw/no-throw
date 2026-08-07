class Config {
  readonly port = readPort();
}

function readPort(): number {
  throw "boom";
}

/** @nothrow */
export function load(): Config {
  return new Config();
}

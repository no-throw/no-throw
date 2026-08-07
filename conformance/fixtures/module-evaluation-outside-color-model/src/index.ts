import "./side-effect.js";

class Registry {
  static readonly created = register();

  static {
    register();
  }
}

function register(): number {
  throw "boom";
}

/** @nothrow */
export function build(): Registry {
  return new Registry();
}

throw "module evaluation runs before any function does";

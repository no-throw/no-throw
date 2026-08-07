function boom(): number {
  throw "boom";
}

function key(): string {
  throw "boom";
}

function seal(): (target: unknown, context: unknown) => void {
  throw "boom";
}

function base(): new () => object {
  throw "boom";
}

/** @nothrow */
export function define(): void {
  @seal()
  class Local extends base() {
    static readonly created = boom();

    static {
      boom();
    }

    [key()](): void {}
  }
}

/** @nothrow */
export function defineBridged(): void {
  try {
    class Local {
      static readonly created = boom();
    }
  } catch {
    return;
  }
}

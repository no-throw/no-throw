declare class Native {
  readonly handle: number;
}

interface HandleFactory {
  new (): Native;
}

declare const Handle: HandleFactory;

/** @nothrow */
export function build(): Native {
  return new Native();
}

/** @nothrow */
export function make(): Native {
  return new Handle();
}

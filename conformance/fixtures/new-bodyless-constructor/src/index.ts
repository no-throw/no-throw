declare class Native {
  readonly handle: number;
}

/** @nothrow */
export function build(): Native {
  return new Native();
}

/** @nothrow */
export function fail(): Error {
  return new Error("boom");
}

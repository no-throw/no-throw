class WrappedError {
  constructor(readonly reason: unknown) {}
}

/** @nothrow */
export function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WrappedError(error);
  }
}

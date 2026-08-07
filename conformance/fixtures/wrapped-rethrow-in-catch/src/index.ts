class WrappedError extends Error {
  constructor(public readonly reason: unknown) {
    super("wrapped");
  }
}

/** @nothrow */
export function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WrappedError(error);
  }
}

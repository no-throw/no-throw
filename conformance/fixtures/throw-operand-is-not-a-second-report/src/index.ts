class MyError {
  constructor(readonly text: string) {
    if (text === "") throw new Error("empty");
  }
}

declare function build(text: string): Error;

/** @nothrow */
export function throwsConstructed(text: string): never {
  throw new MyError(text);
}

/** @nothrow */
export function throwsBuilt(text: string): never {
  throw build(text);
}

/** @nothrow */
export function returnsBuilt(text: string): Error {
  return build(text);
}

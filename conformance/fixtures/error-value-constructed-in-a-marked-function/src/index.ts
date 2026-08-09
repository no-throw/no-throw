export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };

/** @nothrow */
export function plain(): Result<number> {
  return { ok: false, error: new Error("nope") };
}

/** @nothrow */
export function native(): Result<number> {
  return { ok: false, error: new RangeError("out of range") };
}

class Invalid extends Error {
  public override readonly name = "Invalid";
}

/** @nothrow */
export function subclassed(): Result<number> {
  return { ok: false, error: new Invalid("nope") };
}

class Detailed extends Error {
  /** @nothrow */
  public constructor(message: string) {
    super(message);
  }
}

/** @nothrow */
export function explicitSuper(): Result<number> {
  return { ok: false, error: new Detailed("nope") };
}

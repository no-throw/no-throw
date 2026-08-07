export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** @nothrow */
export function safely<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** @nothrow */
export function readJson(text: string): Result<unknown> {
  return safely(() => JSON.parse(text));
}

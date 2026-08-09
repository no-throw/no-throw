export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** @nothrow */
export async function safelyAsync<T>(
  fn: () => Promise<T>,
): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function flaky(): Promise<string> {
  throw "boom";
}

/** @nothrow */
export function read(): Promise<Result<string>> {
  return safelyAsync(() => flaky());
}

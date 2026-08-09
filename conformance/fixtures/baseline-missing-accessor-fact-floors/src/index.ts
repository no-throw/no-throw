/** @nothrow */
export function messageOf(error: Error): string {
  return error.message;
}

/** @nothrow */
export function traceOf(error: Error): string {
  return error.stack ?? "";
}

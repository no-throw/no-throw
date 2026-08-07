function crash(): void {
  throw new Error("boom");
}

function a(): void {
  b();
  crash();
}

/** @nothrow */
export function b(): void {
  a();
}

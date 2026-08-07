function crash(): void {
  throw new Error("boom");
}

function a(): void {
  b();
  crash();
}

function b(): void {
  a();
}

/** @nothrow */
export function run(): void {
  a();
  b();
}

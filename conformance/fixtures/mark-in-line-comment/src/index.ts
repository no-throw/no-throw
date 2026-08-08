// @nothrow
export function lineComment(): number {
  throw new Error("boom");
}

// @nothrow
export class Service {
  fail(): void {
    throw new Error("boom");
  }
}

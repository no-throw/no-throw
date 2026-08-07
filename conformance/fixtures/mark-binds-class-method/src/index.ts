export class Service {
  /** @nothrow */
  fail(): void {
    throw new Error("boom");
  }
}

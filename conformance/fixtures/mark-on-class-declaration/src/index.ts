/** @nothrow */
export class Service {
  fail(): void {
    throw new Error("boom");
  }
}

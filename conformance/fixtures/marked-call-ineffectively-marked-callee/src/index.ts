/** @nothrow */
export class Service {
  fail(): void {
    throw new Error("boom");
  }
}

/** @nothrow */
export function run(service: Service): void {
  service.fail();
}

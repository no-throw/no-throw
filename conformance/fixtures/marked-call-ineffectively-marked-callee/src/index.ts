/** @nothrow */
export class Service {
  fail(): void {
    throw new Error("boom");
  }
}

const service = new Service();

/** @nothrow */
export function run(): void {
  service.fail();
}

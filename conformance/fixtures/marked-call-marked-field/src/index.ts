export class Service {
  /** @nothrow */
  lies = (): void => {
    throw "boom";
  };
}

const service = new Service();

/** @nothrow */
export function trusts(): void {
  service.lies();
}

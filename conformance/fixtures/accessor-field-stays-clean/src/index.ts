export class Service {
  accessor handle = (): void => {};
}

declare const service: Service;

/** @nothrow */
export function read(): () => void {
  return service.handle;
}

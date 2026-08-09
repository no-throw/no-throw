/** @nothrow */
export default (n: number): number => n + 1;

export class Service {
  /** @nothrow */
  handle = (n: number): number => n * 2;

  /** @nothrow */
  static make = (): Service => new Service();
}

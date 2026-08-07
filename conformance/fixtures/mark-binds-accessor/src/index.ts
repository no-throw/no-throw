export class Box {
  /** @nothrow */
  get value(): number {
    throw "boom";
  }

  /** @nothrow */
  set value(next: number) {
    throw "boom";
  }
}

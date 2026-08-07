export class Box {
  /** @nothrow */
  get value(): number {
    throw new Error("boom");
  }

  /** @nothrow */
  set value(next: number) {
    throw new Error("boom");
  }
}

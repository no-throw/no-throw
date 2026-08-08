export class Box {
  private readonly stored = 1;

  /** @nothrow */
  get value(): number {
    return this.stored;
  }
}

class Box {
  get value(): number {
    throw new Error("no");
  }

  set value(next: number) {
    throw new Error("no");
  }
}

declare const optional: Partial<Box>;

/** @nothrow */
export function remove(): void {
  delete optional.value;
}

/** @nothrow */
export function read(): number | undefined {
  return optional.value;
}

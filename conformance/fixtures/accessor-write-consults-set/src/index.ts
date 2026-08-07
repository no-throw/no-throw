class Box {
  get value(): number {
    return 1;
  }

  set value(next: number) {
    throw new Error("no");
  }
}

declare const box: Box;

/** @nothrow */
export function write(): void {
  box.value = 1;
}

/** @nothrow */
export function read(): number {
  return box.value;
}

/** @nothrow */
export function destructure(): number {
  const { value } = box;
  return value;
}

class Box {
  get value(): number {
    throw new Error("no");
  }

  set value(next: number) {}
}

declare const box: Box;

/** @nothrow */
export function read(): number {
  return box.value;
}

/** @nothrow */
export function destructure(): number {
  const { value } = box;
  return value;
}

/** @nothrow */
export function interpolate(): string {
  return `${box.value}`;
}

/** @nothrow */
export function write(): void {
  box.value = 1;
}

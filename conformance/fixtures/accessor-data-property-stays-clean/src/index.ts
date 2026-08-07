class Box {
  data = 1;

  get value(): number {
    throw new Error("no");
  }

  set value(next: number) {
    throw new Error("no");
  }
}

declare const box: Box;

/** @nothrow */
export function read(): number {
  return box.data;
}

/** @nothrow */
export function write(): void {
  box.data = 2;
}

/** @nothrow */
export function update(): void {
  box.data += 1;
}

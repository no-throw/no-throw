declare const flaky: { make(): { use(): void } };

class Box {
  get value(): number {
    throw new Error("no");
  }

  set value(next: number) {
    throw new Error("no");
  }
}

declare function getBox(): Box;

/** @nothrow */
export function padded(s: string): string {
  return s.trim().slice(0, 3).toUpperCase().padEnd(5, "-");
}

/** @nothrow */
export function chained(): void {
  flaky.make().use();
}

/** @nothrow */
export function read(): number {
  return getBox().value;
}

/** @nothrow */
export function write(): void {
  getBox().value = 1;
}

/** @nothrow */
export function update(): void {
  getBox().value += 1;
}

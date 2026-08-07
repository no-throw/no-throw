class ThrowingGet {
  get value(): number {
    throw new Error("no");
  }

  set value(next: number) {}
}

class ThrowingSet {
  get value(): number | undefined {
    return 1;
  }

  set value(next: number | undefined) {
    throw new Error("no");
  }
}

declare const throwingGet: ThrowingGet;
declare const throwingSet: ThrowingSet;

/** @nothrow */
export function compound(): void {
  throwingGet.value += 1;
}

/** @nothrow */
export function increment(): void {
  throwingGet.value++;
}

/** @nothrow */
export function decrement(): void {
  --throwingGet.value;
}

/** @nothrow */
export function nullish(): void {
  throwingSet.value ??= 1;
}

/** @nothrow */
export function logical(): void {
  throwingSet.value ||= 1;
}

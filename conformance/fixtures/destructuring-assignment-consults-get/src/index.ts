class Box {
  data = 1;

  get value(): number {
    throw new Error("no");
  }

  set value(next: number) {}
}

declare const box: Box;
declare const maybe: { out?: number };

/** @nothrow */
export function pullOut(): number {
  let out = 0;
  ({ value: out } = box);
  return out;
}

/** @nothrow */
export function pullOutData(): number {
  let out = 0;
  ({ data: out } = box);
  return out;
}

/** @nothrow */
export function fallBackTo(): number {
  let out = 0;
  ({ out = box.value } = maybe);
  return out;
}

/** @nothrow */
export function shorthand(): number {
  let value = 0;
  ({ value } = box);
  return value;
}

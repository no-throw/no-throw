/** @nothrow */
function startsWithA(s: string): boolean {
  return s.startsWith("a");
}

interface Repeatable {
  repeat(count: number): string;
}

/** @nothrow */
function twice(s: Repeatable): string {
  return s.repeat(2);
}

declare const box: { readonly text: string };

/** @nothrow */
export function fromLiteral(): boolean {
  return startsWithA("abc");
}

/** @nothrow */
export function fromTemplate(n: number): boolean {
  return startsWithA(`a${n}`);
}

/** @nothrow */
export function fromMember(): boolean {
  return startsWithA(box.text);
}

/** @nothrow */
export function fromReassignable(input: string): boolean {
  let text = input;
  text = box.text;
  return startsWithA(text);
}

/** @nothrow */
export function fromConstrainedParameter<K extends string>(key: K): boolean {
  return startsWithA(key);
}

/** @nothrow */
export function repeatsAString(): string {
  return twice("ab");
}

/** @nothrow */
export function parse(input: string): string;
/** @nothrow */
export function parse(input: number): number;
export function parse(input: string | number): string | number {
  return input;
}

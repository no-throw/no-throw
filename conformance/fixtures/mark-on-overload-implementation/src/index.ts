export function parse(input: string): string;
export function parse(input: number): number;
/** @nothrow */
export function parse(input: string | number): string | number {
  throw new Error(String(input));
}

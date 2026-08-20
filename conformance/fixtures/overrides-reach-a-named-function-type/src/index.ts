import { dye, paints } from "paints";

/** @nothrow */
export function paint(text: string): string {
  return paints.red(text);
}

/** @nothrow */
export function detonate(text: string): string {
  return paints.boom(text);
}

/** @nothrow */
export function stain(text: string): string {
  return dye(text);
}

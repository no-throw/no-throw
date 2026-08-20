import pc from "picoish";

/** @nothrow */
export function shout(text: string): string {
  return pc.red(text);
}

/** @nothrow */
export function emphasize(text: string): string {
  return pc.bold(text);
}

/** @nothrow */
export function parse(text: string): string {
  return pc.parse(text);
}

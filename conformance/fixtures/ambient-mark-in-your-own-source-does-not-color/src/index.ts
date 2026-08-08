/** @nothrow */
declare function readConfig(): string;

/** @nothrow */
export function load(): string {
  return readConfig();
}
